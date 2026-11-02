/**
 * 구글 OAuth (로그인 + Gmail 읽기 권한). 라이브러리 없이 구글 공개 규격대로 구현한다.
 * - 로그인: openid email profile
 * - Gmail 연결: 위 + gmail.readonly (보내기 권한은 아예 받지 않는다)
 * 인증 코드 방식 + PKCE, state 는 서버 메모리 + 브라우저 쿠키 둘 다 맞아야 통과한다.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';

export const googleConfigured =
  config.GOOGLE_CLIENT_ID !== '' && config.GOOGLE_CLIENT_SECRET !== '' && config.GOOGLE_REDIRECT_URI !== '';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const LOGIN_SCOPES = 'openid email profile';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** 이 브라우저가 시작한 로그인인지 확인하는 쿠키 (구글에서 돌아올 때 같이 와야 한다) */
export const STATE_COOKIE = 'g_state';
export const STATE_COOKIE_PATH = '/api/auth/google';

export type OAuthMode = 'login' | 'gmail';

interface PendingAuth {
  mode: OAuthMode;
  /** Gmail 연결이면 연결할 사용자 */
  userId?: string;
  verifier: string;
  expires: number;
}

// 시작한 로그인들 (10분 안에 돌아와야 한다). 서버가 한 대라 메모리로 충분하다
const pending = new Map<string, PendingAuth>();
const STATE_TTL_MS = 10 * 60_000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/** 구글 로그인 화면 주소를 만든다. state 는 쿠키로도 내려보내야 한다 */
export function buildAuthUrl(mode: OAuthMode, userId?: string): { url: string; state: string } {
  if (!googleConfigured) throw new HttpError(400, '이 사이트에는 구글 로그인이 설정되어 있지 않아요.');
  sweep();
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  pending.set(state, { mode, userId, verifier, expires: Date.now() + STATE_TTL_MS });
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: mode === 'gmail' ? `${LOGIN_SCOPES} ${GMAIL_SCOPE}` : LOGIN_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Gmail 은 나중에도 쓰려면 리프레시 토큰이 필요하다 (매번 동의 화면을 보여 줘야 확실히 받는다)
    ...(mode === 'gmail' ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } : { prompt: 'select_account' }),
  });
  return { url: `${AUTH_URL}?${params}`, state };
}

/** 돌아온 state 를 확인하고 꺼낸다 (한 번만 쓸 수 있다) */
export function takePending(state: string, cookieState: string | undefined): PendingAuth {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.expires < Date.now()) throw new HttpError(400, '로그인 시간이 지났어요. 처음부터 다시 해 주세요.');
  if (!cookieState || cookieState !== state) throw new HttpError(400, '로그인을 시작한 브라우저가 아니에요. 처음부터 다시 해 주세요.');
  return p;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
}

/**
 * id_token 의 내용 (구글 토큰 주소에서 TLS 로 직접 받은 것이라 서명 확인 없이 읽어도 된다 — OIDC 규격 3.1.3.7).
 * 그래도 발급자·대상·만료는 확인한다.
 */
function readIdToken(idToken: string): GoogleIdentity {
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') throw new Error('발급자가 구글이 아님');
  if (payload.aud !== config.GOOGLE_CLIENT_ID) throw new Error('다른 앱의 토큰');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) throw new Error('만료된 토큰');
  return {
    sub: String(payload.sub),
    email: String(payload.email ?? '').toLowerCase(),
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: String(payload.name ?? payload.given_name ?? '').trim(),
  };
}

/** 구글이 준 코드를 토큰으로 바꾸고 누구인지 알아낸다 */
export async function exchangeCode(code: string, verifier: string): Promise<{ identity: GoogleIdentity; tokens: TokenResponse }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: config.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokens = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok || !tokens.id_token) {
    console.error('[google] 토큰 교환 실패:', tokens.error, tokens.error_description);
    throw new HttpError(400, '구글 로그인에 실패했어요. 다시 시도해 주세요.');
  }
  return { identity: readIdToken(tokens.id_token), tokens };
}

// ───────────── 리프레시 토큰 암호화 (AES-256-GCM, 키는 JWT_SECRET 에서 만든다) ─────────────

const KEY = Buffer.from(crypto.hkdfSync('sha256', config.JWT_SECRET, 'chat-site', 'google-refresh-token', 32));

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(packed: string): string {
  const [iv, tag, data] = packed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8');
}

// ───────────── Gmail 용 접근 토큰 ─────────────

export class GoogleDisconnected extends Error {}

// 접근 토큰은 1시간짜리라 메모리에만 잠깐 둔다
const accessCache = new Map<string, { token: string; expires: number }>();

/** Gmail 을 연결해 둔 사용자의 접근 토큰 (필요하면 새로 받는다) */
export async function gmailAccessToken(userId: string): Promise<string> {
  const cached = accessCache.get(userId);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const { rows } = await pool.query<{ refresh_token_enc: string }>('select refresh_token_enc from google_accounts where user_id = $1', [
    userId,
  ]);
  if (!rows[0]) throw new GoogleDisconnected('Gmail 이 연결되어 있지 않아요. 설정에서 연결해 주세요.');
  let refresh: string;
  try {
    refresh = decrypt(rows[0].refresh_token_enc);
  } catch {
    throw new GoogleDisconnected('Gmail 연결 정보가 깨졌어요. 설정에서 다시 연결해 주세요.');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      // 사용자가 권한을 거뒀거나, 테스트 모드라 7일이 지났다
      await pool.query('delete from google_accounts where user_id = $1', [userId]);
      throw new GoogleDisconnected('Gmail 연결이 만료됐어요. 설정에서 다시 연결해 주세요.');
    }
    throw new Error(`접근 토큰 갱신 실패 (${data.error ?? res.status})`);
  }
  accessCache.set(userId, { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

/** Gmail 연결 끊기: 구글에도 권한을 돌려준다 */
export async function disconnectGmail(userId: string): Promise<void> {
  const { rows } = await pool.query<{ refresh_token_enc: string }>(
    'delete from google_accounts where user_id = $1 returning refresh_token_enc',
    [userId],
  );
  accessCache.delete(userId);
  if (!rows[0]) return;
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: decrypt(rows[0].refresh_token_enc) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn('[google] 권한 돌려주기 실패 (연결은 끊었음):', (err as Error).message);
  }
}
