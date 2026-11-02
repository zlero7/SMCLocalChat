import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAdmin, requireAuth } from '../middleware.js';
import { hashToken } from '../security.js';
import { WINDOW_HOURS, getDefaultLimit, listUsage, resetUsage, setDefaultLimit } from '../quota.js';
import { getMaxSchedules, setMaxSchedules } from '../scheduler.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// 토큰 수는 0(사용 막기) ~ 1억 사이
const limitSchema = z.number().int('정수로 입력해 주세요').min(0, '0 이상이어야 해요').max(100_000_000, '너무 커요');

const settingsResponse = async () => {
  const [defaultTokenLimit, maxSchedules] = await Promise.all([getDefaultLimit(), getMaxSchedules()]);
  return { defaultTokenLimit, windowHours: WINDOW_HOURS, maxSchedules };
};

adminRouter.get('/settings', async (_req, res) => {
  res.json(await settingsResponse());
});

/** 보낸 값만 바꾼다 */
adminRouter.put('/settings', async (req, res) => {
  const body = z
    .object({
      defaultTokenLimit: limitSchema.optional(),
      // 사용자 한 명이 만들 수 있는 예약 작업 수 (0 = 예약 기능 막기)
      maxSchedules: z.number().int('정수로 입력해 주세요').min(0, '0 이상이어야 해요').max(100, '100개 이하로 해 주세요').optional(),
    })
    .parse(req.body);
  if (body.defaultTokenLimit !== undefined) await setDefaultLimit(body.defaultTokenLimit);
  if (body.maxSchedules !== undefined) await setMaxSchedules(body.maxSchedules);
  res.json(await settingsResponse());
});

interface UserRow {
  id: string;
  email: string;
  nickname: string;
  role: string;
  created_at: Date;
  last_active: Date | null;
}

adminRouter.get('/users', async (_req, res) => {
  const [{ rows }, usage] = await Promise.all([
    pool.query<UserRow>(
      `select u.id, u.email, u.nickname, u.role, u.created_at,
              (select max(l.created_at) from usage_logs l where l.user_id = u.id) as last_active
       from users u order by u.created_at`,
    ),
    listUsage(),
  ]);
  res.json({
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      nickname: u.nickname,
      role: u.role,
      createdAt: u.created_at,
      lastActiveAt: u.last_active,
      usage: usage.get(u.id),
    })),
  });
});

function parseUserId(value: unknown): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(404, '사용자를 찾을 수 없어요');
  return parsed.data;
}

/** 사용자별 사용량 제한. null 이면 사이트 기본값을 따른다 */
adminRouter.patch('/users/:id', async (req, res) => {
  const id = parseUserId(req.params.id);
  const { tokenLimit } = z.object({ tokenLimit: limitSchema.nullable() }).parse(req.body);
  const { rowCount } = await pool.query('update users set token_limit = $1 where id = $2', [tokenLimit, id]);
  if (!rowCount) throw new HttpError(404, '사용자를 찾을 수 없어요');
  res.json({ usage: (await listUsage()).get(id) });
});

adminRouter.post('/users/:id/reset-usage', async (req, res) => {
  const id = parseUserId(req.params.id);
  await resetUsage(id);
  res.json({ usage: (await listUsage()).get(id) });
});

/**
 * 비밀번호를 잊은 사용자를 위한 일회용 재설정 링크 (이메일 발송이 없어서 관리자가 직접 전해 준다).
 * 1시간 안에 한 번만 쓸 수 있고, 새로 만들면 이전 링크는 무효가 된다.
 */
adminRouter.post('/users/:id/password-reset', async (req, res) => {
  const id = parseUserId(req.params.id);
  const exists = await pool.query('select 1 from users where id = $1', [id]);
  if (!exists.rowCount) throw new HttpError(404, '사용자를 찾을 수 없어요');
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await pool.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [id]);
  await pool.query('insert into password_resets (user_id, token_hash, created_by, expires_at) values ($1, $2, $3, $4)', [
    id,
    hashToken(token),
    req.user!.id,
    expiresAt,
  ]);
  res.json({ path: `/reset-password?token=${token}`, expiresAt });
});
