// 서버 전체 시험: 따로 만든 임시 데이터베이스에서 가입·로그인·비밀번호 재설정·계정 삭제·백업/복원을 확인한다.
// 실제 데이터에는 손대지 않는다 (시작할 때 chat_test_xxx 를 만들고 끝나면 지운다).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import dotenv from 'dotenv';
import pg from 'pg';

const root = path.resolve(import.meta.dirname, '../../..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });
const realUrl = process.env.DATABASE_URL!;
assert.ok(realUrl, '.env 에 DATABASE_URL 이 있어야 해요');

const dbName = `chat_test_${crypto.randomBytes(4).toString('hex')}`;
const testUrl = realUrl.replace(/\/[^/]+$/, `/${dbName}`);
const ADMIN = 'admin-test@example.test';
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-backup-test-'));

let server: Server;
let fakeDiscord: Server;
let base = '';
let pool: pg.Pool;

// 환경 변수는 서버 코드를 불러오기 전에 정해야 한다
process.env.DATABASE_URL = testUrl;
process.env.REGISTRATION_MODE = 'invite';
process.env.ADMIN_EMAIL = ADMIN;
process.env.COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = '0';
process.env.SERVE_WEB = 'false';
process.env.LOGIN_FAIL_LIMIT_PER_MIN = '1000';
process.env.REGISTER_LIMIT_PER_MIN = '1000';
process.env.BACKUP_DIR = backupDir;
process.env.NODE_ENV = 'test';
process.env.DISCORD_BOTS_ENABLED = 'true';

interface Res {
  status: number;
  body: any;
  cookie?: string;
}
async function call(method: string, url: string, opts: { body?: unknown; token?: string; cookie?: string } = {}): Promise<Res> {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const set = res.headers.getSetCookie().find((c) => c.startsWith('rt='));
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: set?.split(';')[0] };
}

const PASSWORD = 'correct-horse-9';
const mkInvite = async () => {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  await pool.query('insert into invite_codes (code) values ($1)', [code]);
  return code;
};
async function signup(email: string, inviteCode?: string) {
  return call('POST', '/api/auth/register', { body: { email, nickname: email.split('@')[0], password: PASSWORD, inviteCode } });
}

before(async () => {
  const admin = new pg.Pool({ connectionString: realUrl });
  await admin.query(`create database ${dbName}`);
  await admin.end();
  // 가짜 디스코드 서버: 'good-' 로 시작하는 토큰은 봇, 'human-' 은 사용자 계정, 나머지는 거절
  fakeDiscord = http.createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/users/@me' && auth.startsWith('Bot good-')) return void res.end(JSON.stringify({ id: '1' + String(parseInt(crypto.createHash('md5').update(auth).digest('hex').slice(0, 13), 16)).padStart(17, '0'), username: '테스트봇', bot: true }));
    if (req.url === '/users/@me' && auth.startsWith('Bot human-')) return void res.end(JSON.stringify({ id: '999999999999999999', username: '사람' }));
    res.statusCode = 401;
    res.end('{"message":"401: Unauthorized"}');
  }).listen(0);
  process.env.DISCORD_API_BASE = `http://127.0.0.1:${(fakeDiscord.address() as { port: number }).port}`;
  const { migrate, pool: appPool } = await import('../src/db.js');
  pool = appPool;
  await migrate();
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server?.close();
  fakeDiscord?.close();
  await pool?.end();
  const admin = new pg.Pool({ connectionString: realUrl });
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

describe('가입과 로그인', () => {
  it('초대 코드 없이는 가입할 수 없다 (관리자 이메일은 예외)', async () => {
    assert.equal((await signup('nobody@example.test')).status, 403);
    const r = await signup(ADMIN);
    assert.equal(r.status, 201);
    assert.equal(r.body.user.role, 'admin');
  });

  it('초대 코드는 한 번만 쓸 수 있다', async () => {
    const code = await mkInvite();
    assert.equal((await signup('a1@example.test', code)).status, 201);
    const again = await signup('a2@example.test', code);
    assert.ok(again.status >= 400 && again.status < 500, `재사용이 거절돼야 함 (${again.status})`);
  });

  it('틀린 비밀번호는 거절, 맞으면 로그인 + 갱신', async () => {
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a1@example.test', password: 'wrong-password' } })).status, 401);
    const ok = await call('POST', '/api/auth/login', { body: { email: 'a1@example.test', password: PASSWORD } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.accessToken && ok.cookie);
    assert.equal((await call('POST', '/api/auth/refresh', { cookie: ok.cookie })).status, 200);
  });
});

describe('비밀번호 재설정 (관리자가 만든 일회용 링크)', () => {
  let admin: Res;
  let userId = '';
  let oldCookie = '';

  before(async () => {
    admin = await call('POST', '/api/auth/login', { body: { email: ADMIN, password: PASSWORD } });
    const code = await mkInvite();
    const reg = await signup('forgot@example.test', code);
    userId = reg.body.user.id;
    oldCookie = reg.cookie!;
  });

  it('관리자가 아니면 링크를 만들 수 없다', async () => {
    const user = await call('POST', '/api/auth/login', { body: { email: 'a1@example.test', password: PASSWORD } });
    assert.equal((await call('POST', `/api/admin/users/${userId}/password-reset`, { token: user.body.accessToken })).status, 403);
    assert.equal((await call('POST', `/api/admin/users/${userId}/password-reset`)).status, 401);
  });

  it('링크로 비밀번호를 바꾸면 이전 로그인이 풀리고, 링크는 한 번만 된다', async () => {
    const link = await call('POST', `/api/admin/users/${userId}/password-reset`, { token: admin.body.accessToken });
    assert.equal(link.status, 200);
    const token = new URL(link.body.path, 'http://x').searchParams.get('token')!;
    assert.ok(token.length > 30);

    // DB 에는 토큰 원문이 아니라 해시만 있다
    const stored = await pool.query('select token_hash from password_resets where user_id = $1 and used_at is null', [userId]);
    assert.equal(stored.rows.length, 1);
    assert.notEqual(stored.rows[0].token_hash, token);

    assert.equal((await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'short' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'brand-new-pass-1' } })).status, 200);
    assert.equal((await call('POST', '/api/auth/reset-password', { body: { token, newPassword: 'another-pass-2' } })).status, 400, '두 번째는 거절');

    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'forgot@example.test', password: PASSWORD } })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'forgot@example.test', password: 'brand-new-pass-1' } })).status, 200);
    assert.equal((await call('POST', '/api/auth/refresh', { cookie: oldCookie })).status, 401, '예전 로그인은 풀려야 함');
  });

  it('새 링크를 만들면 이전 링크는 못 쓴다', async () => {
    const first = await call('POST', `/api/admin/users/${userId}/password-reset`, { token: admin.body.accessToken });
    await call('POST', `/api/admin/users/${userId}/password-reset`, { token: admin.body.accessToken });
    const t1 = new URL(first.body.path, 'http://x').searchParams.get('token')!;
    assert.equal((await call('POST', '/api/auth/reset-password', { body: { token: t1, newPassword: 'whatever-pass-3' } })).status, 400);
  });

  it('만료된 링크는 거절', async () => {
    const link = await call('POST', `/api/admin/users/${userId}/password-reset`, { token: admin.body.accessToken });
    await pool.query("update password_resets set expires_at = now() - interval '1 minute' where user_id = $1 and used_at is null", [userId]);
    const t = new URL(link.body.path, 'http://x').searchParams.get('token')!;
    assert.equal((await call('POST', '/api/auth/reset-password', { body: { token: t, newPassword: 'whatever-pass-4' } })).status, 400);
  });
});

describe('계정 삭제', () => {
  it('이메일·비밀번호가 맞아야 지워지고, 데이터가 함께 사라진다', async () => {
    const code = await mkInvite();
    const reg = await signup('leaving@example.test', code);
    const token = reg.body.accessToken as string;
    const id = reg.body.user.id as string;
    const conv = await call('POST', '/api/conversations', { token, body: {} });
    assert.equal(conv.status, 201);
    await pool.query("insert into memories (user_id, content) values ($1, '기억 하나')", [id]);

    assert.equal((await call('DELETE', '/api/me', { token, body: { confirmEmail: 'someone-else@example.test', password: PASSWORD } })).status, 400);
    assert.equal((await call('DELETE', '/api/me', { token, body: { confirmEmail: 'leaving@example.test', password: 'wrong' } })).status, 403);
    assert.equal((await call('DELETE', '/api/me', { token, body: { confirmEmail: 'leaving@example.test' } })).status, 400, '비밀번호 없이는 안 됨');

    const del = await call('DELETE', '/api/me', { token, body: { confirmEmail: 'LEAVING@example.test', password: PASSWORD } });
    assert.equal(del.status, 204);
    for (const table of ['users', 'conversations', 'memories', 'refresh_tokens']) {
      const col = table === 'users' ? 'id' : 'user_id';
      assert.equal((await pool.query(`select 1 from ${table} where ${col} = $1`, [id])).rowCount, 0, `${table} 에 남아 있음`);
    }
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'leaving@example.test', password: PASSWORD } })).status, 401);
    assert.equal((await call('POST', '/api/auth/refresh', { cookie: reg.cookie })).status, 401);
  });

  it('마지막 관리자는 지울 수 없다', async () => {
    const admin = await call('POST', '/api/auth/login', { body: { email: ADMIN, password: PASSWORD } });
    const res = await call('DELETE', '/api/me', { token: admin.body.accessToken, body: { confirmEmail: ADMIN, password: PASSWORD } });
    assert.equal(res.status, 409);
  });
});

describe('디스코드 봇 연결 (사용자가 설정에서)', () => {
  const GOOD = 'good-' + 'a'.repeat(60) + '1';
  const GOOD2 = 'good-' + 'b'.repeat(60) + '2';
  let t1 = '';
  let t2 = '';
  let id1 = '';

  before(async () => {
    const a = await signup('bot1@example.test', await mkInvite());
    const b = await signup('bot2@example.test', await mkInvite());
    t1 = a.body.accessToken;
    t2 = b.body.accessToken;
    id1 = a.body.user.id;
  });

  it('로그인해야 쓸 수 있고, 처음에는 연결된 봇이 없다', async () => {
    assert.equal((await call('GET', '/api/discord')).status, 401);
    const r = await call('GET', '/api/discord', { token: t1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.bot, null);
    assert.equal(r.body.serverEnabled, true);
  });

  it('잘못된 토큰·사용자 계정 토큰·너무 짧은 토큰은 거절한다', async () => {
    assert.equal((await call('PUT', '/api/discord/token', { token: t1, body: { token: 'wrong-' + 'x'.repeat(60) } })).status, 400);
    assert.equal((await call('PUT', '/api/discord/token', { token: t1, body: { token: 'human-' + 'x'.repeat(60) } })).status, 400);
    assert.equal((await call('PUT', '/api/discord/token', { token: t1, body: { token: 'short' } })).status, 400);
    assert.equal((await call('GET', '/api/discord', { token: t1 })).body.bot, null);
  });

  it('토큰을 저장하면 암호화되고, 어떤 응답에도 다시 나오지 않는다', async () => {
    const r = await call('PUT', '/api/discord/token', { token: t1, body: { token: GOOD } });
    assert.equal(r.status, 200);
    assert.equal(r.body.bot.botName, '테스트봇');
    assert.match(r.body.bot.inviteUrl, /client_id=\d{18}&scope=bot\+applications\.commands&permissions=\d+/);
    assert.ok(!JSON.stringify(r.body).includes(GOOD), '응답에 토큰이 들어 있음');
    assert.ok(!JSON.stringify((await call('GET', '/api/discord', { token: t1 })).body).includes(GOOD));

    const row = (await pool.query('select token_enc from discord_bots where user_id = $1', [id1])).rows[0];
    assert.ok(row && !row.token_enc.includes(GOOD) && !row.token_enc.includes('aaaa'), '저장된 값이 평문임');
    const { decryptToken } = await import('../src/discord/secret.js');
    assert.equal(decryptToken(row.token_enc), GOOD);
  });

  it('같은 봇을 다른 계정이 쓸 수 없다', async () => {
    assert.equal((await call('PUT', '/api/discord/token', { token: t2, body: { token: GOOD } })).status, 409);
    assert.equal((await call('PUT', '/api/discord/token', { token: t2, body: { token: GOOD2 } })).status, 200);
  });

  it('채널·허용 사용자·DM·켜기 끄기를 바꿀 수 있고, 잘못된 ID 는 거절한다', async () => {
    const ok = await call('PATCH', '/api/discord', {
      token: t1,
      body: { allowedChannels: '123456789012345678, 223456789012345678 123456789012345678', allowedUsers: '323456789012345678', allowDm: false, enabled: false },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.bot.allowedChannels, '123456789012345678,223456789012345678', '중복 제거·쉼표로 정리');
    assert.equal(ok.body.bot.allowedUsers, '323456789012345678');
    assert.equal(ok.body.bot.allowDm, false);
    assert.equal(ok.body.bot.enabled, false);
    assert.equal(ok.body.bot.channelChat, true, '채널 대화는 기본으로 켜져 있다');
    const chatOff = await call('PATCH', '/api/discord', { token: t1, body: { channelChat: false } });
    assert.equal(chatOff.body.bot.channelChat, false);
    assert.equal((await call('POST', '/api/discord/retry', { token: t1 })).status, 200);
    assert.equal((await call('POST', '/api/discord/retry', { token: t2 })).status, 200);
    assert.equal((await call('PATCH', '/api/discord', { token: t1, body: { allowedChannels: '12345, abc' } })).status, 400);
    assert.equal((await call('PATCH', '/api/discord', { token: t1, body: {} })).status, 400);
    const cleared = await call('PATCH', '/api/discord', { token: t1, body: { allowedChannels: '' } });
    assert.equal(cleared.body.bot.allowedChannels, '');
  });

  it('연결 끊기와 계정 삭제는 저장된 토큰을 지운다', async () => {
    assert.equal((await call('DELETE', '/api/discord', { token: t1 })).status, 204);
    assert.equal((await call('GET', '/api/discord', { token: t1 })).body.bot, null);
    assert.equal((await pool.query('select 1 from discord_bots where user_id = $1', [id1])).rowCount, 0);
    // 연결 끊은 봇은 다른 계정이 다시 쓸 수 있다
    assert.equal((await call('PUT', '/api/discord/token', { token: t1, body: { token: GOOD } })).status, 200);
    const me = (await call('GET', '/api/me', { token: t1 })).body.user;
    assert.equal((await call('DELETE', '/api/me', { token: t1, body: { confirmEmail: me.email, password: PASSWORD } })).status, 204);
    assert.equal((await pool.query('select 1 from discord_bots where user_id = $1', [id1])).rowCount, 0, '계정을 지우면 봇 토큰도 지워져야 함');
  });
});

describe('백업과 복원', () => {
  it('백업을 만들고 빈 데이터베이스에 되돌리면 같은 내용이다', () => {
    const script = (name: string, env: Record<string, string>, ...args: string[]) =>
      execFileSync(process.execPath, ['--import', 'tsx', path.join(root, 'apps/api/src/scripts', name), ...args], {
        cwd: path.join(root, 'apps/api'),
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
    const out = script('backup.ts', {});
    assert.match(out, /완료/);
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.ndjson.gz'));
    assert.equal(files.length, 1);
    assert.equal(fs.readdirSync(backupDir).filter((f) => f.endsWith('.part')).length, 0, '임시 파일이 남으면 안 됨');
    // 같은 데이터베이스에 --force 없이 되돌리면 거절
    assert.throws(() => script('restore.ts', {}, path.join(backupDir, files[0]!)), /--force|이미 계정/);
  });
});
