/**
 * 초대 코드 만들기
 *   npm run invite -- 5        → 코드 5개 (유효기간 없음)
 *   npm run invite -- 5 7      → 코드 5개, 7일 뒤 만료
 *   npm run invite -- list     → 사용 현황 보기
 */
import crypto from 'node:crypto';
import { migrate, pool } from '../db.js';

// 헷갈리는 글자(0/O, 1/I)는 뺐다
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

await migrate();
const [arg1, arg2] = process.argv.slice(2);

if (arg1 === 'list') {
  const { rows } = await pool.query(
    `select i.code, i.created_at, i.expires_at, u.email as used_by_email, i.used_at
     from invite_codes i left join users u on u.id = i.used_by
     order by i.created_at desc limit 100`,
  );
  if (rows.length === 0) console.log('초대 코드가 없어요.');
  for (const r of rows) {
    const state = r.used_by_email ? `사용됨 (${r.used_by_email})` : r.expires_at && r.expires_at < new Date() ? '만료' : '미사용';
    console.log(`${r.code}  ${state}`);
  }
} else {
  const count = Math.min(Math.max(Number(arg1) || 1, 1), 100);
  const days = Number(arg2) > 0 ? Number(arg2) : null;
  const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomCode();
    await pool.query('insert into invite_codes (code, expires_at) values ($1, $2)', [code, expiresAt]);
    codes.push(code);
  }
  console.log(codes.join('\n'));
  console.log(`\n초대 코드 ${count}개를 만들었어요${days ? ` (${days}일 뒤 만료)` : ''}.`);
}
await pool.end();
