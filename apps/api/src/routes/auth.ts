import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { hashPassword, hashToken, verifyDummy, verifyPassword } from '../security.js';
import { googleConfigured } from '../google/oauth.js';
import { REFRESH_COOKIE, USER_COLUMNS, clearSessionCookie, issueSession, publicUser, type UserRow } from '../session.js';

export const authRouter = Router();

const tooMany = { error: '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.' };
// 로그인은 "실패한" 시도만 센다. 정상 로그인은 제한에 걸리지 않는다.
const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.LOGIN_FAIL_LIMIT_PER_MIN,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany,
});
const registerLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.REGISTER_LIMIT_PER_MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany,
});

const emailSchema = z.string().trim().toLowerCase().max(254).email('이메일 형식이 올바르지 않아요');

const registerSchema = z.object({
  email: emailSchema,
  nickname: z.string().trim().min(1, '닉네임을 입력해 주세요').max(20, '닉네임은 20자 이하로 해 주세요'),
  password: z.string().min(8, '비밀번호는 8자 이상이어야 해요').max(100, '비밀번호가 너무 길어요'),
  inviteCode: z.string().trim().max(64).optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, '비밀번호를 입력해 주세요').max(100),
});

/** 프론트가 가입 화면에서 초대 코드 입력칸을 보일지 결정하는 데 쓴다. */
authRouter.get('/options', (_req, res) => {
  res.json({ registrationMode: config.REGISTRATION_MODE, google: googleConfigured, contactEmail: config.CONTACT_EMAIL || config.ADMIN_EMAIL });
});

authRouter.post('/register', registerLimiter, async (req, res) => {
  const { email, nickname, password, inviteCode } = registerSchema.parse(req.body);

  const isAdminEmail = config.ADMIN_EMAIL !== '' && email === config.ADMIN_EMAIL;
  const needInvite = config.REGISTRATION_MODE === 'invite' && !isAdminEmail;
  if (needInvite && !inviteCode) throw new HttpError(403, '초대 코드가 필요해요');

  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  let user: UserRow;
  try {
    await client.query('begin');
    const inserted = await client.query<UserRow>(
      `insert into users (email, nickname, password_hash, role)
       values ($1, $2, $3, $4)
       on conflict (email) do nothing
       returning ${USER_COLUMNS}`,
      [email, nickname, passwordHash, isAdminEmail ? 'admin' : 'user'],
    );
    if (inserted.rowCount === 0) throw new HttpError(409, '이미 가입된 이메일이에요');
    user = inserted.rows[0]!;

    if (needInvite) {
      // 코드 사용 처리는 한 문장으로 원자적으로 (동시에 같은 코드를 써도 한 명만 성공)
      const used = await client.query(
        `update invite_codes set used_by = $1, used_at = now()
         where code = $2 and used_by is null and (expires_at is null or expires_at > now())`,
        [user.id, inviteCode!.toUpperCase()],
      );
      if (used.rowCount === 0) throw new HttpError(403, '유효하지 않거나 이미 사용된 초대 코드예요');
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const session = await issueSession(res, user);
  res.status(201).json({ user: publicUser(user), ...session });
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const { rows } = await pool.query<UserRow & { password_hash: string | null }>(
    `select ${USER_COLUMNS}, password_hash from users where email = $1`,
    [email],
  );
  const row = rows[0];
  let ok = false;
  // 구글로만 가입해 비밀번호가 없는 계정도 "틀림"으로 똑같이 답한다 (계정 유무를 응답 시간으로 알아내지 못하게)
  if (row?.password_hash) ok = await verifyPassword(password, row.password_hash);
  else await verifyDummy(password);
  if (!row || !ok) throw new HttpError(401, '이메일 또는 비밀번호가 맞지 않아요');

  const session = await issueSession(res, row);
  res.json({ user: publicUser(row), ...session });
});

/** 리프레시 토큰은 쓸 때마다 새것으로 교체(rotation)된다. 한 번 쓴 토큰은 다시 못 쓴다. */
authRouter.post('/refresh', async (req, res) => {
  const token: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof token !== 'string' || !token) throw new HttpError(401, '로그인이 필요해요');

  const revoked = await pool.query<{ user_id: string }>(
    `update refresh_tokens set revoked_at = now()
     where token_hash = $1 and revoked_at is null and expires_at > now()
     returning user_id`,
    [hashToken(token)],
  );
  let userId = revoked.rows[0]?.user_id;
  if (!userId) {
    // 방금(30초 안에) 교체된 토큰이면 한 번 더 받아 준다.
    // 새로고침·탭 여러 개처럼 갱신 요청이 겹치거나, 응답(새 쿠키)을 받기 전에 페이지를 옮기면
    // 옛 토큰으로 다시 오는데, 이때 로그아웃시키지 않으려는 것이다.
    const recent = await pool.query<{ user_id: string }>(
      `select user_id from refresh_tokens
       where token_hash = $1 and revoked_at > now() - interval '30 seconds' and expires_at > now()`,
      [hashToken(token)],
    );
    userId = recent.rows[0]?.user_id;
  }
  if (!userId) {
    clearSessionCookie(res);
    throw new HttpError(401, '로그인이 만료됐어요. 다시 로그인해 주세요.');
  }

  const { rows } = await pool.query<UserRow>(`select ${USER_COLUMNS} from users where id = $1`, [userId]);
  const user = rows[0];
  if (!user) {
    clearSessionCookie(res);
    throw new HttpError(401, '로그인이 필요해요');
  }

  const session = await issueSession(res, user);
  res.json({ user: publicUser(user), ...session });
});

authRouter.post('/logout', async (req, res) => {
  const token: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof token === 'string' && token) {
    await pool.query('update refresh_tokens set revoked_at = now(), expires_at = now() where token_hash = $1', [
      hashToken(token),
    ]);
  }
  clearSessionCookie(res);
  res.status(204).end();
});

const resetLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: tooMany });

/** 관리자가 만들어 준 일회용 링크로 새 비밀번호를 정한다 */
authRouter.post('/reset-password', resetLimiter, async (req, res) => {
  const { token, newPassword } = z
    .object({ token: z.string().min(20).max(200), newPassword: z.string().min(8, '새 비밀번호는 8자 이상이어야 해요').max(100) })
    .parse(req.body);
  const passwordHash = await hashPassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('begin');
    // 한 번만 쓰이게: 아직 안 쓰였고 만료 전인 것을 쓰인 것으로 바꾸면서 가져온다
    const used = await client.query<{ user_id: string }>(
      `update password_resets set used_at = now()
       where token_hash = $1 and used_at is null and expires_at > now() returning user_id`,
      [hashToken(token)],
    );
    if (!used.rows[0]) {
      await client.query('rollback');
      throw new HttpError(400, '링크가 만료됐거나 이미 사용됐어요. 관리자에게 새 링크를 요청해 주세요');
    }
    const userId = used.rows[0].user_id;
    await client.query('update users set password_hash = $1 where id = $2', [passwordHash, userId]);
    // 이 사람이 쓰던 로그인과 다른 재설정 링크를 모두 무효로
    await client.query('update refresh_tokens set revoked_at = now(), expires_at = now() where user_id = $1 and expires_at > now()', [userId]);
    await client.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [userId]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});
