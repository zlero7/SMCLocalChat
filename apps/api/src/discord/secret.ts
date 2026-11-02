import crypto from 'node:crypto';
import { config } from '../config.js';

// 봇 토큰 암호화 (AES-256-GCM). 키는 JWT_SECRET 에서 이 용도 전용으로 만든다 (구글 토큰 키와 다르다)
const KEY = Buffer.from(crypto.hkdfSync('sha256', config.JWT_SECRET, 'chat-site', 'discord-bot-token', 32));

export function encryptToken(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptToken(packed: string): string {
  const [iv, tag, data] = packed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8');
}
