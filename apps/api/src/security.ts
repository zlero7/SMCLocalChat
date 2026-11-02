import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

const BCRYPT_ROUNDS = 12;
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

// 존재하지 않는 계정으로 로그인 시도할 때도 같은 시간이 걸리도록 쓰는 더미 해시
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);
export const verifyDummy = (password: string) => bcrypt.compare(password, DUMMY_HASH);

export interface AccessPayload {
  sub: string;
  role: string;
}

export function signAccessToken(user: { id: string; role: string }): string {
  return jwt.sign({ role: user.role } satisfies Omit<AccessPayload, 'sub'>, config.JWT_SECRET, {
    subject: user.id,
    expiresIn: ACCESS_TOKEN_TTL_SEC,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessPayload | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || !decoded.sub) return null;
    return { sub: decoded.sub, role: String((decoded as jwt.JwtPayload).role ?? 'user') };
  } catch {
    return null;
  }
}

/** 리프레시 토큰: 원문은 쿠키로만 나가고, DB 에는 SHA-256 해시만 저장한다. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
