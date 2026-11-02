#!/usr/bin/env node
/**
 * chat-site 프로그램 실행 도우미.
 *
 * 내 컴퓨터에서 켜 두면, 사이트의 AI 가 "내 컴퓨터 폴더" 안에서 명령(python, npm, git …)을 실행할 수 있다.
 * 사이트 서버는 명령을 실행하지 않는다. 오직 이 프로그램을 켠 컴퓨터에서, 지정한 폴더 안에서만 실행된다.
 *
 * 사용법 (Node.js 18 이상 필요):
 *   node chat-site-runner.mjs "C:\\내\\프로젝트\\폴더"
 *   node chat-site-runner.mjs . --port 47821 --allow https://내사이트주소
 *
 * 켜면 "연결 코드"가 나온다. 사이트의 설정 → 프로그램 실행에 그 코드를 붙여 넣으면 연결된다.
 * 끄려면 이 창에서 Ctrl+C.
 *
 * 안전 장치
 *  - 내 컴퓨터 안(127.0.0.1)에서만 받는다. 바깥에서는 접속할 수 없다.
 *  - 연결 코드가 맞는 요청, 그리고 허용한 사이트 주소에서 온 요청만 처리한다.
 *  - 명령의 시작 위치는 항상 지정한 폴더 안이다. (명령 자체가 다른 곳을 건드리는 것까지는 막을 수 없으니,
 *    믿는 폴더에서만 켜고 사이트의 "허용" 질문을 꼭 읽어 보자.)
 *  - 시간 제한이 있고, 시간이 지나면 명령과 그 자식 프로그램까지 모두 끈다.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const VERSION = 1;
const DEFAULT_ORIGINS = ['https://smcaichat.zlero.xyz', 'http://localhost:4100', 'http://127.0.0.1:4100', 'http://localhost:5173'];
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
const MAX_OUTPUT_CHARS = 20_000;
const IS_WIN = process.platform === 'win32';

// ───────── 인자 ─────────
const argv = process.argv.slice(2);
let folderArg = null;
let port = 47821;
const origins = [...DEFAULT_ORIGINS];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') port = Number(argv[++i]);
  else if (a === '--allow') origins.push(String(argv[++i]).replace(/\/+$/, ''));
  else if (a === '-h' || a === '--help') {
    console.log('사용법: node chat-site-runner.mjs "<작업 폴더>" [--port 47821] [--allow https://사이트주소]');
    process.exit(0);
  } else if (!folderArg) folderArg = a;
}
if (!folderArg) {
  console.error('작업 폴더를 알려 주세요.\n  예) node chat-site-runner.mjs "C:\\내\\프로젝트"');
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('--port 는 1024~65535 사이 숫자여야 해요.');
  process.exit(1);
}
let ROOT;
try {
  ROOT = fs.realpathSync(path.resolve(folderArg));
  if (!fs.statSync(ROOT).isDirectory()) throw new Error('폴더가 아니에요');
} catch (err) {
  console.error(`작업 폴더를 열 수 없어요: ${folderArg} (${err.message})`);
  process.exit(1);
}
if (ROOT === path.parse(ROOT).root) {
  console.error('드라이브 전체(루트)는 작업 폴더로 쓸 수 없어요. 프로젝트 폴더를 지정해 주세요.');
  process.exit(1);
}

// ───────── 연결 코드 (한 번 만들어 두고 계속 쓴다) ─────────
const CONFIG = path.join(os.homedir(), '.chat-site-runner.json');
function loadToken() {
  try {
    const t = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).token;
    if (typeof t === 'string' && t.length >= 32) return t;
  } catch {
    /* 처음 켠 것 */
  }
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    fs.writeFileSync(CONFIG, JSON.stringify({ token }), { mode: 0o600 });
  } catch {
    /* 저장하지 못하면 이번에만 쓴다 */
  }
  return token;
}
const TOKEN = loadToken();
const tokenBuf = Buffer.from(TOKEN);

// ───────── 막아 둘 명령 (마지막 안전망일 뿐, 보안 경계가 아니다) ─────────
const BLOCKED = [
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(\/|~|\$HOME|\*)(\s|$)/i, '루트·홈 폴더 전체 삭제'],
  [/\b(rd|rmdir)\s+\/s\b.*\s[a-z]:\\?(\s|$)/i, '드라이브 전체 삭제'],
  [/\bdel\s+.*\/s\b.*\s[a-z]:\\\*?(\s|$)/i, '드라이브 전체 삭제'],
  [/\bformat\s+[a-z]:/i, '드라이브 포맷'],
  [/\bmkfs(\.|\s)/i, '디스크 포맷'],
  [/\bdd\s+.*\bof=\/dev\//i, '디스크 덮어쓰기'],
  [/\b(shutdown|poweroff|halt)\b|\breboot\b/i, '컴퓨터 끄기·재시작'],
  [/remove-item\s+.*-recurse.*\s[a-z]:\\?(\s|$)/i, '드라이브 전체 삭제'],
];

function resolveCwd(rel) {
  const r = typeof rel === 'string' && rel.trim() ? rel.trim() : '.';
  if (/^[a-zA-Z]:/.test(r) || r.startsWith('/') || r.startsWith('\\')) throw new Error('시작 위치는 작업 폴더 기준 상대 경로여야 해요');
  const full = path.resolve(ROOT, r);
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    throw new Error(`없는 폴더예요: ${r}`);
  }
  const rootCmp = IS_WIN ? ROOT.toLowerCase() : ROOT;
  const realCmp = IS_WIN ? real.toLowerCase() : real;
  if (realCmp !== rootCmp && !realCmp.startsWith(rootCmp + path.sep)) throw new Error('작업 폴더 밖에서는 실행할 수 없어요');
  if (!fs.statSync(real).isDirectory()) throw new Error(`폴더가 아니에요: ${r}`);
  return real;
}

function killTree(child) {
  try {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 이미 끝남 */
    }
  }
}

let running = false;

function runCommand({ command, cwd, timeoutSec }) {
  return new Promise((resolve) => {
    const started = Date.now();
    // 윈도우: 명령을 임시 배치 파일에 UTF-8 로 적어 실행한다. 첫 줄에서 코드 페이지를 UTF-8 로 바꾸면
    // 그 아래 줄(명령)과 출력의 한글이 깨지지 않고, 따옴표를 겹쳐 감쌀 필요도 없다.
    let batch = null;
    if (IS_WIN) {
      batch = path.join(os.tmpdir(), `chat-site-run-${crypto.randomBytes(6).toString('hex')}.cmd`);
      // 첫 줄: 코드 페이지를 UTF-8 로, 둘째 줄: 명령 줄이 출력에 섞이지 않게 에코 끄기
      fs.writeFileSync(batch, ['@chcp 65001>nul', '@echo off', command, ''].join('\r\n'), { mode: 0o600 });
    }
    const child = IS_WIN
      ? spawn('cmd.exe', ['/d', '/c', `"${batch}"`], {
          cwd,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    // 출력이 아주 길어도 메모리를 아끼려고 앞부분과 뒷부분만 모은다
    const HALF = MAX_OUTPUT_CHARS / 2;
    const head = [];
    let headLen = 0;
    let tail = Buffer.alloc(0);
    let total = 0;
    const onData = (d) => {
      total += d.length;
      if (headLen < HALF) {
        head.push(d);
        headLen += d.length;
      } else {
        tail = Buffer.concat([tail, d]);
        if (tail.length > HALF) tail = tail.subarray(tail.length - HALF);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSec * 1000);

    const finish = (exitCode, signal, spawnError) => {
      clearTimeout(timer);
      if (batch) fs.rm(batch, { force: true }, () => {});
      let output = Buffer.concat(head).toString('utf8').slice(0, HALF * 2);
      if (tail.length) {
        const skipped = Math.max(0, total - headLen - tail.length);
        output += `\n…(출력이 길어서 가운데 ${skipped}바이트를 생략함)…\n${tail.toString('utf8')}`;
      }
      resolve({ exitCode, signal, timedOut, output: spawnError ? `${output}\n${spawnError}` : output, ms: Date.now() - started });
    };
    child.on('error', (err) => finish(-1, null, `실행하지 못했어요: ${err.message}`));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

// ───────── 서버 ─────────
const hostOk = (host) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(new Error('요청이 너무 커요'));
        req.destroy();
      } else parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // DNS 리바인딩 방어: 우리 주소로 들어온 요청만
  if (!hostOk(req.headers.host ?? '')) return send(403, { error: '허용되지 않은 접속이에요' });

  if (origin) {
    if (!origins.includes(origin)) return send(403, { error: `허용되지 않은 사이트예요: ${origin}. --allow ${origin} 으로 다시 켜세요` });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  if (given.length !== tokenBuf.length || !crypto.timingSafeEqual(given, tokenBuf)) {
    return send(401, { error: '연결 코드가 맞지 않아요' });
  }

  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/ping') {
    return send(200, { ok: true, version: VERSION, folder: path.basename(ROOT), platform: process.platform, shell: IS_WIN ? 'cmd.exe' : 'sh' });
  }

  if (req.method === 'POST' && url.pathname === '/run') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(400, { error: '요청 형식이 잘못됐어요' });
    }
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) return send(400, { error: '실행할 명령이 비어 있어요' });
    if (command.length > 8000) return send(400, { error: '명령이 너무 길어요' });
    const blocked = BLOCKED.find(([re]) => re.test(command));
    if (blocked) return send(403, { error: `위험한 명령이라 실행하지 않아요 (${blocked[1]})` });
    let cwd;
    try {
      cwd = resolveCwd(body.cwd);
    } catch (err) {
      return send(400, { error: err.message });
    }
    const timeoutSec = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Number.isFinite(body.timeoutSec) ? Math.floor(body.timeoutSec) : DEFAULT_TIMEOUT_SEC));
    if (running) return send(409, { error: '앞선 명령이 아직 실행 중이에요. 끝난 뒤에 다시 시도해 주세요' });
    running = true;
    console.log(`\n▶ ${new Date().toLocaleTimeString()}  ${path.relative(ROOT, cwd) || '.'}> ${command}`);
    try {
      const out = await runCommand({ command, cwd, timeoutSec });
      console.log(`■ 종료 코드 ${out.exitCode ?? out.signal}${out.timedOut ? ' (시간 초과로 끔)' : ''}  ${(out.ms / 1000).toFixed(1)}초`);
      return send(200, { ...out, platform: process.platform, shell: IS_WIN ? 'cmd.exe' : 'sh' });
    } finally {
      running = false;
    }
  }
  return send(404, { error: '없는 주소예요' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`포트 ${port} 를 이미 쓰고 있어요. 도우미가 이미 켜져 있거나, --port 로 다른 번호를 쓰세요.`);
  else console.error('서버 오류:', err.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log('────────────────────────────────────────────');
  console.log(' chat-site 프로그램 실행 도우미가 켜졌어요');
  console.log('────────────────────────────────────────────');
  console.log(` 작업 폴더 : ${ROOT}`);
  console.log(` 포트      : ${port}`);
  console.log(` 허용 사이트: ${origins.join(', ')}`);
  console.log('');
  console.log(` 연결 코드 : ${TOKEN}`);
  console.log('');
  console.log(' → 사이트 설정 → "프로그램 실행" 에 위 연결 코드를 붙여 넣으세요.');
  console.log(' → 끄려면 이 창에서 Ctrl+C');
});
