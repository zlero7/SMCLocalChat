#!/usr/bin/env node
/**
 * API 스모크 테스트 (가짜 LLM 서버 + 임시 DB 로 전체 흐름 확인)
 *
 * 준비: 아래 환경으로 API 서버와 fake-llm 을 먼저 띄워 두세요.
 *   REGISTRATION_MODE=invite  ADMIN_EMAIL=admin@test.com  LLM_CONCURRENCY=1
 *   MESSAGE_RATE_PER_MIN=1000  REGISTER_LIMIT_PER_MIN=1000  LLM_BASE_URL=http://127.0.0.1:8099/v1
 * 실행: node scripts/smoke.mjs   (DATABASE_URL 등은 API 와 같은 환경 변수 필요: 초대 코드 생성에 사용)
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4100';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

class Client {
  constructor(name) {
    this.name = name;
    this.token = null;
    this.cookie = null;
  }

  async req(method, p, body, signal) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(BASE + p, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      if (c.startsWith('rt=')) {
        const kv = c.split(';')[0];
        this.cookie = kv === 'rt=' ? null : kv;
      }
    }
    return res;
  }

  async json(method, p, body) {
    const res = await this.req(method, p, body);
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data };
  }

  /** SSE 응답을 끝까지 읽어서 이벤트 배열로 돌려준다 */
  async stream(p, body, onEvent, signal) {
    const res = await this.req('POST', p, body, signal);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      return { status: res.status, events: [], error: data?.error };
    }
    const events = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        const ev = { event, data: JSON.parse(data) };
        events.push(ev);
        onEvent?.(ev);
      }
    }
    return { status: res.status, events };
  }
}

const textOf = (events, kind) =>
  events
    .filter((e) => e.event === kind)
    .map((e) => e.data.text)
    .join('');
const doneOf = (events) => events.findLast((e) => e.event === 'done')?.data;

async function newConv(c) {
  const r = await c.json('POST', '/api/conversations', {});
  assert.equal(r.status, 201);
  return r.data.conversation.id;
}

async function main() {
  console.log(`API 스모크 테스트: ${BASE}\n`);

  // ── 기본 ──
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  ok('헬스체크');

  const unauth = await fetch(`${BASE}/api/conversations`);
  assert.equal(unauth.status, 401);
  ok('로그인 없이 대화 목록 접근 → 401');

  // npx 대신 node 로 직접 실행 (Windows 에선 npx 가 npx.cmd 라 execFileSync 로 못 찾는다)
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'apps/api/src/scripts/invite.ts', '3'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });
  const codes = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(l));
  assert.equal(codes.length, 3);
  ok('초대 코드 3개 생성');

  const admin = new Client('admin');
  const alice = new Client('alice');
  const bob = new Client('bob');
  const carol = new Client('carol');

  // ── 가입 / 초대 코드 ──
  const base = { nickname: '앨리스', password: 'password123' };
  let r = await alice.json('POST', '/api/auth/register', { ...base, email: 'alice@test.com' });
  assert.equal(r.status, 403);
  ok('초대 코드 없이 가입 → 403');

  r = await alice.json('POST', '/api/auth/register', { ...base, email: 'alice@test.com', inviteCode: 'ZZZZ-ZZZZ' });
  assert.equal(r.status, 403);
  ok('없는 초대 코드 → 403');

  r = await alice.json('POST', '/api/auth/register', { ...base, email: 'alice@test.com', password: 'short' });
  assert.equal(r.status, 400);
  ok('짧은 비밀번호 → 400');

  r = await alice.json('POST', '/api/auth/register', { ...base, email: 'alice@test.com', inviteCode: codes[0] });
  assert.equal(r.status, 201);
  assert.ok(r.data.accessToken);
  assert.equal(r.data.user.role, 'user');
  assert.ok(alice.cookie?.startsWith('rt='));
  alice.token = r.data.accessToken;
  ok('앨리스 가입 (초대 코드) → 201, 리프레시 쿠키 발급');

  r = await bob.json('POST', '/api/auth/register', {
    ...base,
    nickname: '밥',
    email: 'bob@test.com',
    inviteCode: codes[0].toLowerCase(),
  });
  assert.equal(r.status, 403);
  ok('이미 사용된 초대 코드 재사용 → 403');

  r = await bob.json('POST', '/api/auth/register', { ...base, nickname: '밥', email: 'bob@test.com', inviteCode: codes[1] });
  assert.equal(r.status, 201);
  bob.token = r.data.accessToken;
  ok('밥 가입');

  r = await carol.json('POST', '/api/auth/register', { ...base, email: 'alice@test.com', inviteCode: codes[2] });
  assert.equal(r.status, 409);
  r = await carol.json('POST', '/api/auth/register', { ...base, nickname: '캐롤', email: 'carol@test.com', inviteCode: codes[2] });
  assert.equal(r.status, 201);
  carol.token = r.data.accessToken;
  ok('중복 이메일은 409, 그때 초대 코드는 소모되지 않음(롤백)');

  r = await admin.json('POST', '/api/auth/register', { ...base, nickname: '관리자', email: 'admin@test.com' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'admin');
  admin.token = r.data.accessToken; // 아래 관리자 API 테스트에서 쓴다
  ok('ADMIN_EMAIL 은 초대 코드 없이 가입, role=admin');

  // ── 로그인 / 토큰 ──
  const a2 = new Client('alice-login');
  r = await a2.json('POST', '/api/auth/login', { email: 'alice@test.com', password: 'wrong-password' });
  assert.equal(r.status, 401);
  r = await a2.json('POST', '/api/auth/login', { email: 'ALICE@test.com', password: 'password123' });
  assert.equal(r.status, 200);
  a2.token = r.data.accessToken;
  ok('로그인 실패 401 / 성공 200 (이메일 대소문자 무시)');

  const oldCookie = alice.cookie;
  r = await alice.json('POST', '/api/auth/refresh');
  assert.equal(r.status, 200);
  assert.ok(r.data.accessToken);
  assert.notEqual(alice.cookie, oldCookie);
  alice.token = r.data.accessToken;
  const replay = new Client('replay');
  replay.cookie = oldCookie;
  r = await replay.json('POST', '/api/auth/refresh');
  assert.equal(r.status, 401);
  ok('리프레시 토큰은 한 번 쓰면 교체됨 (재사용 → 401)');

  r = await alice.json('GET', '/api/me');
  assert.equal(r.data.user.email, 'alice@test.com');
  ok('내 정보 조회');

  // ── 스트리밍 대화 ──
  const convA = await newConv(alice);
  const pathA = `/api/conversations/${convA}/messages`;
  const first = await alice.stream(pathA, { content: '안녕하세요 첫 질문입니다' });
  assert.equal(first.status, 200);
  const types = new Set(first.events.map((e) => e.event));
  for (const t of ['title', 'start', 'reasoning', 'delta', 'done']) assert.ok(types.has(t), `이벤트 ${t} 없음`);
  assert.equal(doneOf(first.events).status, 'done');
  assert.ok(doneOf(first.events).messageId);
  assert.match(textOf(first.events, 'delta'), /가짜 모델의 답변/);
  assert.equal(textOf(first.events, 'reasoning'), '먼저 질문을 살펴볼게요.');
  const titles = first.events.filter((e) => e.event === 'title').map((e) => e.data.title);
  assert.equal(titles[0], '안녕하세요 첫 질문입니다');
  assert.equal(titles.at(-1), '테스트 제목');
  ok('SSE 스트리밍: 생각/답변 분리, 임시 제목 → 모델이 만든 제목');

  r = await alice.json('GET', `/api/conversations/${convA}`);
  assert.equal(r.data.messages.length, 2);
  assert.deepEqual(
    r.data.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.equal(r.data.messages[1].status, 'done');
  assert.equal(r.data.messages[1].reasoning, '먼저 질문을 살펴볼게요.');
  assert.equal(r.data.conversation.title, '테스트 제목');
  ok('저장된 대화 조회 (user/assistant, reasoning 보존, 제목 갱신)');

  const second = await alice.stream(pathA, { content: '두 번째 질문' });
  assert.match(textOf(second.events, 'delta'), /이전 메시지 수: 4/);
  assert.equal(second.events.filter((e) => e.event === 'title').length, 0);
  ok('이전 대화가 컨텍스트로 전달됨 (system + 대화 3개 = 4)');

  const convT = await newConv(alice);
  const think = await alice.stream(`/api/conversations/${convT}/messages`, { content: '[think] 태그 테스트' });
  assert.equal(textOf(think.events, 'delta'), '진짜 답변이에요');
  assert.equal(textOf(think.events, 'reasoning'), '비밀 생각');
  ok('content 안의 <think> 태그(청크 경계 분리)도 생각/답변으로 분리');

  const convF = await newConv(alice);
  const failed = await alice.stream(`/api/conversations/${convF}/messages`, { content: '[fail] 오류 테스트' });
  assert.ok(failed.events.some((e) => e.event === 'error'));
  assert.equal(doneOf(failed.events).status, 'error');
  r = await alice.json('GET', `/api/conversations/${convF}`);
  assert.equal(r.data.messages.at(-1).status, 'error');
  ok('모델 서버 오류 → error 이벤트, 오류 메시지가 기록됨');

  // ── 입력 검증 ──
  r = await alice.json('POST', pathA, { content: '   ' });
  assert.equal(r.status, 400);
  r = await alice.json('POST', pathA, { content: 'a'.repeat(8001) });
  assert.equal(r.status, 400);
  r = await alice.json('GET', '/api/conversations/not-a-uuid');
  assert.equal(r.status, 404);
  ok('빈 메시지/너무 긴 메시지 → 400, 잘못된 id → 404');

  // ── 모델 선택 ──
  const st = await alice.json('GET', '/api/status');
  assert.ok(Array.isArray(st.data.models) && st.data.models.some((m) => m.id === st.data.model));
  r = await alice.json('POST', pathA, { content: '안녕', model: 'no-such-model' });
  assert.equal(r.status, 400);
  r = await alice.json('GET', pathA.replace(/\/messages$/, ''));
  assert.equal(r.data.messages.find((m) => m.role === 'assistant').model, st.data.model);
  ok('모델 목록 제공, 목록에 없는 모델 → 400, 답변에 사용한 모델 기록');

  // ── 응답 스타일 ──
  r = await alice.json('GET', '/api/styles');
  assert.equal(r.status, 200);
  assert.ok(r.data.presets.length >= 5 && r.data.presets.some((p) => p.id === 'concise'));
  assert.equal(r.data.selected, 'default');
  r = await alice.json('POST', '/api/styles', { name: '해적 말투', instruction: '해적처럼 말한다. 문장 끝에 "아르르"를 붙인다.' });
  assert.equal(r.status, 201);
  const myStyle = r.data.style.id;
  r = await alice.json('PATCH', '/api/me', { styleId: myStyle, customInstruction: '나는 고등학생이다' });
  assert.equal(r.data.user.styleId, myStyle);
  const sysConv = await newConv(alice);
  let sys = await alice.stream(`/api/conversations/${sysConv}/messages`, { content: '[system] 확인' });
  let sysText = textOf(sys.events, 'delta');
  assert.match(sysText, /\[응답 스타일: 해적 말투\]/);
  assert.match(sysText, /아르르/);
  assert.match(sysText, /\[사용자 개인 지침\]\n나는 고등학생이다/);
  ok('내 스타일 만들기 → 고르면 시스템 프롬프트에 스타일과 개인 지침이 들어감');

  r = await alice.json('PATCH', '/api/me', { styleId: 'concise' });
  assert.equal(r.data.user.styleId, 'concise');
  sys = await alice.stream(`/api/conversations/${sysConv}/messages`, { content: '[system] 다시' });
  assert.match(textOf(sys.events, 'delta'), /\[응답 스타일: 간결하게\]/);
  r = await alice.json('PATCH', '/api/me', { styleId: 'no-such-style' });
  assert.equal(r.status, 400);
  r = await bob.json('PATCH', '/api/me', { styleId: myStyle }); // 남의 스타일은 고를 수 없다
  assert.equal(r.status, 400);
  r = await bob.json('PATCH', `/api/styles/${myStyle}`, { name: '뺏기', instruction: 'x' });
  assert.equal(r.status, 404);
  r = await bob.json('DELETE', `/api/styles/${myStyle}`);
  assert.equal(r.status, 404);
  ok('기본 스타일 고르기, 없는 스타일/남의 스타일 → 400·404');

  await alice.json('PATCH', '/api/me', { styleId: myStyle });
  r = await alice.json('DELETE', `/api/styles/${myStyle}`);
  assert.equal(r.status, 204);
  r = await alice.json('GET', '/api/styles');
  assert.equal(r.data.selected, 'default');
  assert.equal(r.data.custom.length, 0);
  await alice.json('PATCH', '/api/me', { customInstruction: '' });
  ok('쓰던 스타일을 지우면 기본 스타일로 돌아감');

  // ── 관리자: 사용량 한도 ──
  r = await alice.json('GET', '/api/admin/users');
  assert.equal(r.status, 403);
  r = await admin.json('GET', '/api/admin/settings');
  assert.equal(r.status, 200);
  assert.equal(r.data.windowHours, 5);
  const defaultLimit = r.data.defaultTokenLimit;
  r = await admin.json('PUT', '/api/admin/settings', { defaultTokenLimit: -1 });
  assert.equal(r.status, 400);
  r = await admin.json('PUT', '/api/admin/settings', { defaultTokenLimit: 123456 });
  assert.equal(r.data.defaultTokenLimit, 123456);
  r = await bob.json('GET', '/api/me/usage');
  assert.equal(r.data.usage.limit, 123456);
  await admin.json('PUT', '/api/admin/settings', { defaultTokenLimit: defaultLimit });
  ok('관리자만 관리자 API 사용(일반 사용자 403), 기본 한도 변경이 바로 반영');

  r = await bob.json('GET', '/api/me/usage');
  assert.equal(r.data.usage.used, 0);
  assert.equal(r.data.usage.resetAt, null); // 아직 메시지를 안 보냈으면 창이 없다
  r = await admin.json('GET', '/api/admin/users');
  const bobId = r.data.users.find((u) => u.email === 'bob@test.com').id;
  // 가짜 모델은 한 번에 59 토큰(42+17)을 쓴다 → 한도 100 이면 두 번까지 보낼 수 있다
  r = await admin.json('PATCH', `/api/admin/users/${bobId}`, { tokenLimit: 100 });
  assert.equal(r.data.usage.limit, 100);
  assert.equal(r.data.usage.custom, true);
  const bobConv = await newConv(bob);
  const bobPath = `/api/conversations/${bobConv}/messages`;
  assert.equal(doneOf((await bob.stream(bobPath, { content: '하나' })).events).status, 'done');
  r = await bob.json('GET', '/api/me/usage');
  assert.equal(r.data.usage.used, 59);
  const resetAt = Date.parse(r.data.usage.resetAt);
  assert.ok(Math.abs(resetAt - Date.now() - 5 * 3600_000) < 60_000, '첫 메시지부터 5시간 뒤에 초기화');
  assert.equal(doneOf((await bob.stream(bobPath, { content: '둘' })).events).status, 'done');
  let over = await bob.stream(bobPath, { content: '셋' });
  assert.equal(over.status, 429);
  assert.match(over.error, /5시간 사용량을 모두 썼어요/);
  r = await bob.json('GET', bobPath.replace(/\/messages$/, ''));
  assert.equal(r.data.messages.length, 4); // 거절된 메시지는 저장되지 않는다
  ok('사용량 한도: 첫 메시지부터 5시간 창, 한도를 넘으면 429 (메시지 저장 안 함)');

  r = await admin.json('POST', `/api/admin/users/${bobId}/reset-usage`);
  assert.equal(r.data.usage.used, 0);
  assert.equal(doneOf((await bob.stream(bobPath, { content: '초기화 뒤' })).events).status, 'done');
  r = await admin.json('PATCH', `/api/admin/users/${bobId}`, { tokenLimit: 0 });
  over = await bob.stream(bobPath, { content: '막힘' });
  assert.equal(over.status, 429);
  assert.match(over.error, /막아/);
  r = await admin.json('PATCH', `/api/admin/users/${bobId}`, { tokenLimit: null });
  assert.equal(r.data.usage.custom, false);
  assert.equal(r.data.usage.limit, defaultLimit);
  await bob.json('DELETE', `/api/conversations/${bobConv}`); // 아래 소유권 테스트는 밥의 대화가 0개라고 가정한다
  ok('관리자 사용량 초기화 → 다시 사용 가능, 한도 0 → 사용 막힘, null → 기본값으로');

  // ── 소유권 격리 (밥이 앨리스 대화에 접근) ──
  r = await bob.json('GET', '/api/conversations');
  assert.equal(r.data.items.length, 0);
  r = await bob.json('GET', `/api/conversations/${convA}`);
  assert.equal(r.status, 404);
  r = await bob.json('PATCH', `/api/conversations/${convA}`, { title: '탈취' });
  assert.equal(r.status, 404);
  r = await bob.json('DELETE', `/api/conversations/${convA}`);
  assert.equal(r.status, 404);
  const steal = await bob.stream(pathA, { content: '남의 대화에 쓰기' });
  assert.equal(steal.status, 404);
  r = await alice.json('GET', `/api/conversations/${convA}`);
  assert.equal(r.data.messages.length, 4);
  assert.equal(r.data.conversation.title, '테스트 제목');
  ok('다른 사용자의 대화 조회/수정/삭제/메시지 전송 모두 404, 원본 변함없음');

  // ── 중단 + 동시 요청 거부 ──
  const convS = await newConv(alice);
  const pathS = `/api/conversations/${convS}/messages`;
  let fired = false;
  let conflictStatus = 0;
  let stopBody = null;
  let side;
  const slow = await alice.stream(pathS, { content: '[slow] 느린 질문' }, (ev) => {
    if (!fired && ev.event === 'delta') {
      fired = true;
      side = (async () => {
        conflictStatus = (await alice.json('POST', pathS, { content: '동시 요청' })).status;
        stopBody = (await alice.json('POST', `/api/conversations/${convS}/stop`)).data;
      })();
    }
  });
  await side;
  assert.equal(conflictStatus, 409);
  assert.equal(stopBody.stopped, true);
  assert.equal(doneOf(slow.events).status, 'stopped');
  r = await alice.json('GET', `/api/conversations/${convS}`);
  const savedPartial = r.data.messages.at(-1);
  assert.equal(savedPartial.status, 'stopped');
  assert.ok(savedPartial.content.length > 0);
  ok('생성 중 동시 전송 → 409, 중단 → stopped 로 받은 데까지 저장');

  // ── 연결이 끊기면 생성도 멈추고 부분 저장 ──
  const convD = await newConv(alice);
  const ctrl = new AbortController();
  let dropped = false;
  await alice
    .stream(
      `/api/conversations/${convD}/messages`,
      { content: '[slow] 중간에 끊기' },
      (ev) => {
        if (!dropped && ev.event === 'delta') {
          dropped = true;
          ctrl.abort();
        }
      },
      ctrl.signal,
    )
    .catch(() => {});
  await sleep(700);
  r = await alice.json('GET', `/api/conversations/${convD}`);
  assert.equal(r.data.messages.at(-1).status, 'stopped');
  r = await alice.json('GET', '/api/status');
  assert.equal(r.data.active, 0);
  assert.equal(r.data.online, true);
  ok('브라우저 연결 끊김 → 모델 호출 중단, 부분 답변 저장, 슬롯 반환');

  // ── 대기열 (동시 생성 1 로 띄운 서버 기준) ──
  const convQ1 = await newConv(alice);
  const convQ2 = await newConv(bob);
  let aStarted;
  const aStartedP = new Promise((res) => (aStarted = res));
  const aRun = alice.stream(`/api/conversations/${convQ1}/messages`, { content: '[slow] 앨리스가 먼저' }, (ev) => {
    if (ev.event === 'delta') aStarted();
  });
  await aStartedP;
  let bQueued;
  const bQueuedP = new Promise((res) => (bQueued = res));
  const bRun = bob.stream(`/api/conversations/${convQ2}/messages`, { content: '밥의 질문' }, (ev) => {
    if (ev.event === 'queue') bQueued(ev.data.position);
  });
  assert.equal(await bQueuedP, 1);
  r = await alice.json('GET', '/api/status');
  assert.equal(r.data.active, 1);
  assert.equal(r.data.waiting, 1);
  await alice.json('POST', `/api/conversations/${convQ1}/stop`);
  const [aDone, bDone] = await Promise.all([aRun, bRun]);
  assert.equal(doneOf(aDone.events).status, 'stopped');
  assert.ok(bDone.events.some((e) => e.event === 'start'));
  assert.equal(doneOf(bDone.events).status, 'done');
  ok('슬롯이 꽉 차면 queue(순번 1) → 앞 작업이 끝나면 자동 시작');

  // 대기 중 취소
  let aStarted2;
  const aStarted2P = new Promise((res) => (aStarted2 = res));
  const convQ3 = await newConv(alice);
  const aRun2 = alice.stream(`/api/conversations/${convQ3}/messages`, { content: '[slow] 또 앨리스' }, (ev) => {
    if (ev.event === 'delta') aStarted2();
  });
  await aStarted2P;
  const convQ4 = await newConv(bob);
  let bQ2;
  const bQ2P = new Promise((res) => (bQ2 = res));
  const bRun2 = bob.stream(`/api/conversations/${convQ4}/messages`, { content: '대기 중 취소할 질문' }, (ev) => {
    if (ev.event === 'queue') bQ2();
  });
  await bQ2P;
  await bob.json('POST', `/api/conversations/${convQ4}/stop`);
  const bCancelled = await bRun2;
  assert.equal(doneOf(bCancelled.events).status, 'stopped');
  assert.equal(doneOf(bCancelled.events).messageId, null);
  r = await bob.json('GET', `/api/conversations/${convQ4}`);
  assert.equal(r.data.messages.length, 1);
  await alice.json('POST', `/api/conversations/${convQ3}/stop`);
  await aRun2;
  ok('대기 중에 중단하면 답변 없이 stopped (빈 답변은 저장 안 함)');

  // ── 대화 관리 ──
  r = await alice.json('PATCH', `/api/conversations/${convA}`, { title: '이름 바꾼 대화' });
  assert.equal(r.data.conversation.title, '이름 바꾼 대화');
  r = await alice.json('GET', '/api/conversations?limit=2');
  assert.equal(r.data.items.length, 2);
  assert.ok(r.data.nextCursor);
  const page2 = await alice.json('GET', `/api/conversations?limit=50&cursor=${encodeURIComponent(r.data.nextCursor)}`);
  assert.ok(page2.data.items.length >= 1);
  assert.ok(!page2.data.items.some((i) => r.data.items.some((j) => j.id === i.id)));
  ok('이름 변경, 커서 페이지네이션(겹치지 않음)');

  r = await alice.json('DELETE', `/api/conversations/${convA}`);
  assert.equal(r.status, 204);
  r = await alice.json('GET', `/api/conversations/${convA}`);
  assert.equal(r.status, 404);
  r = await alice.json('GET', '/api/conversations?limit=100');
  assert.ok(!r.data.items.some((i) => i.id === convA));
  ok('삭제한 대화는 목록/조회에서 사라짐');

  // ── 내 컴퓨터 폴더: AI 의 파일 작업은 브라우저가 실행하고 결과를 돌려준다 ──
  const toolConv = await newConv(alice);
  const toolPath = `/api/conversations/${toolConv}/messages`;
  // 테스트가 브라우저 역할: tool_exec 를 받으면 정해 둔 결과를 보낸다
  const actAsBrowser = (reply) => (ev) => {
    if (ev.event === 'tool_exec') {
      void alice.json('POST', `/api/conversations/${toolConv}/tool-result`, { callId: ev.data.id, ...reply(ev.data) });
    }
  };

  let ws = await alice.stream(
    toolPath,
    { content: '[tool:list] 목록', localFolder: 'my-project' },
    actAsBrowser(() => ({ status: 'ok', result: '[파일] calc.py (116바이트)', summary: '. — 1개' })),
  );
  const exec1 = ws.events.find((e) => e.event === 'tool_exec');
  assert.equal(exec1?.data.name, 'list_dir');
  assert.equal(exec1?.data.needsApproval, false);
  const res1 = ws.events.find((e) => e.event === 'tool_result');
  assert.equal(res1?.data.status, 'ok');
  assert.match(textOf(ws.events, 'delta'), /도구 결과: \[파일\] calc\.py/);
  ok('폴더를 연 대화: 도구 호출을 브라우저에 보내고(tool_exec), 브라우저 결과를 모델에게 전달');

  ws = await alice.stream(
    toolPath,
    { content: '[tool:write] 만들어', localFolder: 'my-project' },
    actAsBrowser(() => ({ status: 'denied', result: '사용자가 이 작업을 거절했습니다.', summary: '거절함' })),
  );
  const exec2 = ws.events.find((e) => e.event === 'tool_exec');
  assert.equal(exec2?.data.name, 'write_file');
  assert.equal(exec2?.data.needsApproval, true);
  assert.equal(exec2?.data.args.content, '가짜 모델이 만든 파일');
  assert.equal(ws.events.find((e) => e.event === 'tool_result')?.data.status, 'denied');
  r = await alice.json('GET', `/api/conversations/${toolConv}`);
  assert.equal(r.data.messages.at(-1).tools[0].status, 'denied');
  assert.equal(r.data.messages.at(-1).tools[0].args.content, '(1줄)'); // 저장 기록에는 파일 내용 대신 줄 수만
  ok('쓰기 도구는 허용이 필요하다고 표시되고, 브라우저가 거절하면 거절로 기록됨');

  r = await alice.json('POST', `/api/conversations/${toolConv}/tool-result`, {
    callId: 'nope',
    status: 'ok',
    result: 'x',
    summary: 'x',
  });
  assert.equal(r.status, 404);
  r = await bob.json('POST', `/api/conversations/${toolConv}/tool-result`, { callId: 'nope', status: 'ok', result: 'x', summary: 'x' });
  assert.equal(r.status, 404);
  ws = await alice.stream(toolPath, { content: '[tool:write] 폴더 없이' });
  assert.equal(ws.events.filter((e) => e.event.startsWith('tool')).length, 0);
  ok('기다리는 작업 없는 결과·남의 대화 결과 → 404, 폴더 없이 보낸 메시지는 도구 없음');

  // ── 내 설정 ──
  r = await alice.json('PATCH', '/api/me', { nickname: '앨리스2', customInstruction: '항상 존댓말로 답해 줘' });
  assert.equal(r.data.user.nickname, '앨리스2');
  assert.equal(r.data.user.customInstruction, '항상 존댓말로 답해 줘');
  r = await alice.json('PATCH', '/api/me', { currentPassword: 'nope-nope', newPassword: 'new-password-1' });
  assert.equal(r.status, 403);
  const beforePw = alice.cookie;
  r = await alice.json('PATCH', '/api/me', { currentPassword: 'password123', newPassword: 'new-password-1' });
  assert.equal(r.status, 200);
  assert.ok(r.data.accessToken);
  alice.token = r.data.accessToken;
  assert.notEqual(alice.cookie, beforePw);
  const stale = new Client('stale');
  stale.cookie = a2.cookie;
  r = await stale.json('POST', '/api/auth/refresh');
  assert.equal(r.status, 401);
  r = await new Client('x').json('POST', '/api/auth/login', { email: 'alice@test.com', password: 'new-password-1' });
  assert.equal(r.status, 200);
  ok('닉네임/커스텀 지시 저장, 비밀번호 변경 시 다른 기기 로그아웃 + 이 기기는 새 세션');

  // ── 로그아웃 ──
  r = await alice.json('POST', '/api/auth/logout');
  assert.equal(r.status, 204);
  r = await alice.json('POST', '/api/auth/refresh');
  assert.equal(r.status, 401);
  ok('로그아웃 후 리프레시 불가');

  // ── 로그인 시도 제한 (마지막에: IP 기준이라 이후 로그인이 막힘) ──
  const attacker = new Client('attacker');
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    statuses.push((await attacker.json('POST', '/api/auth/login', { email: 'nobody@test.com', password: 'guess-guess' })).status);
  }
  assert.equal(statuses[0], 401);
  assert.ok(statuses.includes(429), `429 가 없음: ${statuses}`);
  ok(`로그인 실패가 반복되면 429 (${statuses.join(',')})`);

  console.log(`\n✅ ${passed}개 항목 통과`);
}

main().catch((err) => {
  console.error(`\n❌ 실패 (${passed}개 통과 후): ${err.stack || err}`);
  process.exit(1);
});
