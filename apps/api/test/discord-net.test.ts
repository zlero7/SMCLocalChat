// 디스코드로 가는 연결이 "other side closed" 로 끊겨도 새 연결로 다시 보내서 파일이 올라가는지
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { REST, Routes } from 'discord.js';
import { isNetworkGlitch, shortLivedAgent, withNetRetry } from '../src/discord/manager.js';

describe('연결 끊김 판별', () => {
  it('끊김 오류만 다시 시도할 대상으로 본다', () => {
    assert.equal(isNetworkGlitch(Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' })), true);
    assert.equal(isNetworkGlitch(new Error('read ECONNRESET')), true);
    assert.equal(isNetworkGlitch(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_SOCKET' } })), true);
    assert.equal(isNetworkGlitch(Object.assign(new Error('Missing Permissions'), { code: 50013 })), false);
    assert.equal(isNetworkGlitch(new Error('Unknown Channel')), false);
  });

  it('두 번까지 다시 시도하고, 다른 오류는 바로 던진다', async () => {
    let n = 0;
    const glitch = () => Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    assert.equal(await withNetRetry(async () => (++n < 3 ? Promise.reject(glitch()) : 'ok'), async () => {}), 'ok');
    assert.equal(n, 3);
    n = 0;
    await assert.rejects(withNetRetry(async () => (++n, Promise.reject(glitch())), async () => {}), /other side closed/);
    assert.equal(n, 3, '처음 1번 + 다시 2번');
    n = 0;
    await assert.rejects(withNetRetry(async () => (++n, Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013 }))), async () => {}), /Missing Permissions/);
    assert.equal(n, 1, '권한 오류는 다시 시도해도 소용없다');
  });
});

describe('끊긴 연결 위에서 파일 올리기 (가짜 디스코드)', () => {
  let server: http.Server;
  let api = '';
  const requestsPerSocket = new WeakMap<object, number>();
  let accepted = 0;
  before(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: '1', channel_id: '2', content: 'ok', attachments: [{ filename: 'a.py', size: Buffer.concat(chunks).length }] }));
      });
    });
    // 같은 연결로 두 번째 요청이 들어오면 아무 응답 없이 끊어 버린다 (오래 놀던 연결을 서버가 닫은 상황)
    server.on('request', (req) => {
      const n = (requestsPerSocket.get(req.socket) ?? 0) + 1;
      requestsPerSocket.set(req.socket, n);
      if (n >= 2) req.socket.destroy();
    });
    server.on('connection', () => accepted++);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(() => server.close());

  const upload = (rest: REST) =>
    rest.post(Routes.channelMessages('123456789012345678'), { body: { content: '📎' }, files: [{ name: 'a.py', data: Buffer.from('print(1)\n') }] });

  it('withNetRetry 로 감싸면 새 연결로 다시 보내서 성공한다', async () => {
    const rest = new REST({ api, version: '10', retries: 0, agent: shortLivedAgent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000 }) as never }).setToken('x'.repeat(59));
    await upload(rest);
    const before = accepted;
    const res = (await withNetRetry(() => upload(rest))) as { attachments: { filename: string }[] };
    assert.equal(res.attachments[0]!.filename, 'a.py');
    assert.ok(accepted > before, '새 연결을 열었어야 함');
  });

  it('짧게 유지하는 연결 풀을 만들 수 있다', () => {
    assert.ok(shortLivedAgent(), 'discord.js 가 쓰는 undici 를 찾지 못함');
  });
});
