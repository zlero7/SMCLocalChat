import type { CookieOptions, Response } from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_MS, newRefreshToken, signAccessToken } from './security.js';

export const REFRESH_COOKIE = 'rt';

const baseCookie: CookieOptions = {
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: 'lax',
  path: '/api/auth',
};

export interface UserRow {
  id: string;
  email: string;
  nickname: string;
  role: string;
  custom_instruction: string;
  style_id: string;
  memory_enabled: boolean;
  created_at: Date;
}

export const USER_COLUMNS = 'id, email, nickname, role, custom_instruction, style_id, memory_enabled, created_at';

export const publicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  nickname: u.nickname,
  role: u.role,
  customInstruction: u.custom_instruction,
  styleId: u.style_id,
  memoryEnabled: u.memory_enabled,
  createdAt: u.created_at,
});

/** 새 리프레시 토큰을 만들어 쿠키로 내려주고, 액세스 토큰을 돌려준다. */
export async function issueSession(res: Response, user: { id: string; role: string }) {
  const { token, hash } = newRefreshToken();
  await pool.query('insert into refresh_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)', [
    user.id,
    hash,
    new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  ]);
  res.cookie(REFRESH_COOKIE, token, { ...baseCookie, maxAge: REFRESH_TOKEN_TTL_MS });
  return { accessToken: signAccessToken(user), expiresIn: ACCESS_TOKEN_TTL_SEC };
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, baseCookie);
}
