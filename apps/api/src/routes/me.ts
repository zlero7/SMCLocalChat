import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { deleteAccount, isLastAdmin } from '../accountDeletion.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../middleware.js';
import { getUsage } from '../quota.js';
import { hashPassword, verifyPassword } from '../security.js';
import { USER_COLUMNS, clearSessionCookie, issueSession, publicUser, type UserRow } from '../session.js';
import { isSelectableStyle } from '../styles.js';
import { MAX_MEMORIES, addMemory, listMemories, toMemory } from '../llm/memory.js';

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/', async (req, res) => {
  const { rows } = await pool.query<UserRow>(`select ${USER_COLUMNS} from users where id = $1`, [req.user!.id]);
  if (!rows[0]) throw new HttpError(401, '로그인이 필요해요');
  res.json({ user: publicUser(rows[0]) });
});

/** 5시간 사용량 (얼마나 썼는지, 언제 초기화되는지) */
meRouter.get('/usage', async (req, res) => {
  res.json({ usage: await getUsage(req.user!.id) });
});

const patchSchema = z
  .object({
    nickname: z.string().trim().min(1, '닉네임을 입력해 주세요').max(20, '닉네임은 20자 이하로 해 주세요').optional(),
    customInstruction: z.string().max(2000, '개인 지침은 2000자 이하로 해 주세요').optional(),
    styleId: z.string().max(64).optional(),
    // 기억 기능 켜기/끄기
    memoryEnabled: z.boolean().optional(),
    currentPassword: z.string().max(100).optional(),
    newPassword: z.string().min(8, '새 비밀번호는 8자 이상이어야 해요').max(100).optional(),
  });

meRouter.patch('/', async (req, res) => {
  const body = patchSchema.parse(req.body);
  const userId = req.user!.id;

  if (body.newPassword) {
    const { rows } = await pool.query<{ password_hash: string | null }>('select password_hash from users where id = $1', [userId]);
    if (!rows[0]) throw new HttpError(401, '로그인이 필요해요');
    // 구글로만 가입해 비밀번호가 없으면 현재 비밀번호 없이 새로 정할 수 있다
    if (rows[0].password_hash) {
      if (!body.currentPassword) throw new HttpError(400, '현재 비밀번호를 입력해 주세요');
      if (!(await verifyPassword(body.currentPassword, rows[0].password_hash))) {
        throw new HttpError(403, '현재 비밀번호가 맞지 않아요');
      }
    }
    await pool.query('update users set password_hash = $1 where id = $2', [await hashPassword(body.newPassword), userId]);
    // 비밀번호를 바꾸면 모든 기기의 로그인을 끊는다 (이 기기는 아래에서 새 세션을 받는다)
    await pool.query('update refresh_tokens set revoked_at = now(), expires_at = now() where user_id = $1 and expires_at > now()', [userId]);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.nickname !== undefined) {
    values.push(body.nickname);
    sets.push(`nickname = $${values.length}`);
  }
  if (body.customInstruction !== undefined) {
    values.push(body.customInstruction.trim());
    sets.push(`custom_instruction = $${values.length}`);
  }
  if (body.styleId !== undefined) {
    if (!(await isSelectableStyle(userId, body.styleId))) throw new HttpError(400, '고를 수 없는 스타일이에요');
    values.push(body.styleId);
    sets.push(`style_id = $${values.length}`);
  }
  if (body.memoryEnabled !== undefined) {
    values.push(body.memoryEnabled);
    sets.push(`memory_enabled = $${values.length}`);
  }
  if (sets.length > 0) {
    values.push(userId);
    await pool.query(`update users set ${sets.join(', ')} where id = $${values.length}`, values);
  }

  const { rows } = await pool.query<UserRow>(`select ${USER_COLUMNS} from users where id = $1`, [userId]);
  const user = rows[0];
  if (!user) throw new HttpError(401, '로그인이 필요해요');

  const session = body.newPassword ? await issueSession(res, user) : {};
  res.json({ user: publicUser(user), ...session });
});

// ───────────── 기억 ─────────────

meRouter.get('/memories', async (req, res) => {
  res.json({ items: (await listMemories(req.user!.id)).map(toMemory), max: MAX_MEMORIES });
});

/** 직접 적어 넣는 기억 */
meRouter.post('/memories', async (req, res) => {
  const { content } = z
    .object({ content: z.string().trim().min(2, '기억할 내용을 적어 주세요').max(200, '200자 이하로 적어 주세요') })
    .parse(req.body);
  const count = await pool.query<{ n: number }>('select count(*)::int as n from memories where user_id = $1', [req.user!.id]);
  if ((count.rows[0]?.n ?? 0) >= MAX_MEMORIES) throw new HttpError(400, `기억은 ${MAX_MEMORIES}개까지예요. 안 쓰는 것을 지워 주세요.`);
  res.status(201).json({ memory: toMemory(await addMemory(req.user!.id, content)) });
});

meRouter.delete('/memories/:id', async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, '기억을 찾을 수 없어요');
  const { rowCount } = await pool.query('delete from memories where id = $1 and user_id = $2', [id.data, req.user!.id]);
  if (!rowCount) throw new HttpError(404, '기억을 찾을 수 없어요');
  res.status(204).end();
});

/** 기억 모두 지우기 */
meRouter.delete('/memories', async (req, res) => {
  await pool.query('delete from memories where user_id = $1', [req.user!.id]);
  res.status(204).end();
});

/**
 * 내 계정 삭제. 대화·파일·기억·예약·프로젝트·공유 링크가 모두 지워지고 되돌릴 수 없다.
 * 이메일을 똑같이 입력해야 하고, 비밀번호가 있는 계정은 비밀번호도 맞아야 한다.
 */
meRouter.delete('/', async (req, res) => {
  const body = z
    .object({ confirmEmail: z.string().trim().toLowerCase().max(254), password: z.string().max(100).optional() })
    .parse(req.body);
  const userId = req.user!.id;
  const { rows } = await pool.query<{ email: string; password_hash: string | null }>('select email, password_hash from users where id = $1', [userId]);
  if (!rows[0]) throw new HttpError(401, '로그인이 필요해요');
  if (body.confirmEmail !== rows[0].email) throw new HttpError(400, '이메일이 내 계정과 달라요. 정확히 입력해 주세요');
  if (rows[0].password_hash) {
    if (!body.password) throw new HttpError(400, '비밀번호를 입력해 주세요');
    if (!(await verifyPassword(body.password, rows[0].password_hash))) throw new HttpError(403, '비밀번호가 맞지 않아요');
  }
  if (await isLastAdmin(userId)) {
    throw new HttpError(409, '마지막 관리자는 계정을 지울 수 없어요. 다른 사람을 관리자로 만든 뒤에 지워 주세요');
  }
  await deleteAccount(userId);
  clearSessionCookie(res);
  res.status(204).end();
});
