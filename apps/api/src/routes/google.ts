import { Router, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import {
  GMAIL_SCOPE,
  STATE_COOKIE,
  STATE_COOKIE_PATH,
  buildAuthUrl,
  disconnectGmail,
  encrypt,
  exchangeCode,
  googleConfigured,
  takePending,
} from '../google/oauth.js';
import { requireAuth } from '../middleware.js';
import { USER_COLUMNS, issueSession, type UserRow } from '../session.js';

const setStateCookie = (res: Response, state: string) =>
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax', // 구글에서 돌아오는 이동(최상위 GET)에는 같이 온다
    secure: config.COOKIE_SECURE,
    path: STATE_COOKIE_PATH,
    maxAge: 10 * 60_000,
  });

/** 로그인 없이 쓰는 경로: /api/auth/google/… */
export const googleAuthRouter = Router();

/** "Google 로 계속하기": 구글 로그인 화면으로 보낸다 */
googleAuthRouter.get('/start', (_req, res) => {
  if (!googleConfigured) return void res.redirect('/login?error=' + encodeURIComponent('구글 로그인이 설정되어 있지 않아요.'));
  const { url, state } = buildAuthUrl('login');
  setStateCookie(res, state);
  res.redirect(url);
});

/** 구글 이메일로 기존 계정을 찾거나(연결) 새로 만든다 */
async function findOrCreateUser(identity: { sub: string; email: string; name: string }): Promise<UserRow> {
  const bySub = await pool.query<UserRow>(`select ${USER_COLUMNS} from users where google_sub = $1`, [identity.sub]);
  if (bySub.rows[0]) return bySub.rows[0];
  // 같은 이메일로 가입한 계정이 있으면 구글 로그인을 이어 붙인다 (구글이 확인한 이메일일 때만 여기까지 온다)
  const byEmail = await pool.query<UserRow>(
    `update users set google_sub = $1 where email = $2 and google_sub is null returning ${USER_COLUMNS}`,
    [identity.sub, identity.email],
  );
  if (byEmail.rows[0]) return byEmail.rows[0];

  const isAdminEmail = config.ADMIN_EMAIL !== '' && identity.email === config.ADMIN_EMAIL;
  if (config.REGISTRATION_MODE === 'invite' && !isAdminEmail) {
    throw new HttpError(403, '초대받은 사람만 가입할 수 있어요. 초대 코드로 먼저 가입한 뒤, 같은 이메일의 구글 계정으로 로그인하면 이어져요.');
  }
  const nickname = Array.from(identity.name || identity.email.split('@')[0] || '사용자').slice(0, 20).join('');
  const created = await pool.query<UserRow>(
    `insert into users (email, nickname, password_hash, role, google_sub)
     values ($1, $2, null, $3, $4)
     on conflict (email) do nothing
     returning ${USER_COLUMNS}`,
    [identity.email, nickname, isAdminEmail ? 'admin' : 'user', identity.sub],
  );
  if (!created.rows[0]) throw new HttpError(409, '이미 다른 구글 계정과 연결된 이메일이에요.');
  return created.rows[0];
}

/** 구글이 로그인(또는 Gmail 동의)을 마치고 돌려보내는 곳 */
googleAuthRouter.get('/callback', async (req, res) => {
  const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
  const cookieState = req.cookies?.[STATE_COOKIE] as string | undefined;
  res.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH });
  let mode: 'login' | 'gmail' = 'login';
  try {
    if (!q.state) throw new HttpError(400, '잘못된 접근이에요.');
    const pending = takePending(q.state, cookieState);
    mode = pending.mode;
    if (q.error || !q.code) {
      throw new HttpError(400, q.error === 'access_denied' ? '구글에서 허용하지 않았어요.' : '구글 로그인에 실패했어요.');
    }
    const { identity, tokens } = await exchangeCode(q.code, pending.verifier);
    if (!identity.emailVerified || !identity.email) throw new HttpError(400, '구글이 확인하지 않은 이메일이라 쓸 수 없어요.');

    if (pending.mode === 'login') {
      const user = await findOrCreateUser(identity);
      await issueSession(res, user); // 로그인 쿠키를 심고, 화면은 그 쿠키로 접속 토큰을 받는다
      return void res.redirect('/chat');
    }

    // Gmail 연결
    if (!tokens.scope.split(' ').includes(GMAIL_SCOPE)) {
      throw new HttpError(400, 'Gmail 읽기 권한에 체크하지 않았어요. 다시 연결하면서 "Gmail 메일 보기" 를 허용해 주세요.');
    }
    if (!tokens.refresh_token) throw new HttpError(400, '구글이 오래 쓸 권한을 주지 않았어요. 다시 연결해 주세요.');
    const owner = await pool.query('select 1 from users where id = $1', [pending.userId]);
    if (!owner.rowCount) throw new HttpError(400, '계정을 찾을 수 없어요.');
    await pool.query(
      `insert into google_accounts (user_id, google_sub, email, scopes, refresh_token_enc)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update set google_sub = excluded.google_sub, email = excluded.email,
         scopes = excluded.scopes, refresh_token_enc = excluded.refresh_token_enc, connected_at = now()`,
      [pending.userId, identity.sub, identity.email, tokens.scope, encrypt(tokens.refresh_token)],
    );
    res.redirect('/settings?google=connected#google');
  } catch (err) {
    const message = err instanceof HttpError ? err.message : '구글 로그인 중 문제가 생겼어요.';
    if (!(err instanceof HttpError)) console.error('[google] 처리 실패:', (err as Error).message);
    res.redirect(mode === 'gmail' ? `/settings?google_error=${encodeURIComponent(message)}#google` : `/login?error=${encodeURIComponent(message)}`);
  }
});

/** 로그인한 사람이 쓰는 경로: /api/google/… */
export const googleRouter = Router();
googleRouter.use(requireAuth);

googleRouter.get('/status', async (req, res) => {
  const [user, gmail] = await Promise.all([
    pool.query<{ google_sub: string | null; has_password: boolean }>(
      'select google_sub, password_hash is not null as has_password from users where id = $1',
      [req.user!.id],
    ),
    pool.query<{ email: string; connected_at: Date }>('select email, connected_at from google_accounts where user_id = $1', [req.user!.id]),
  ]);
  res.json({
    configured: googleConfigured,
    // 구글 로그인으로 들어올 수 있는지 (같은 이메일의 구글 계정과 이어져 있는지)
    linked: !!user.rows[0]?.google_sub,
    hasPassword: !!user.rows[0]?.has_password,
    gmail: gmail.rows[0] ? { email: gmail.rows[0].email, connectedAt: gmail.rows[0].connected_at } : null,
  });
});

/** Gmail 연결 시작: 구글 동의 화면 주소를 돌려준다 (화면이 그 주소로 이동한다) */
googleRouter.post('/gmail/connect', (req, res) => {
  const { url, state } = buildAuthUrl('gmail', req.user!.id);
  setStateCookie(res, state);
  res.json({ url });
});

googleRouter.delete('/gmail', async (req, res) => {
  await disconnectGmail(req.user!.id);
  res.status(204).end();
});
