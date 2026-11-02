/**
 * 프로그램 실행 도우미(public/chat-site-runner.mjs)와 이야기하는 부분.
 * 도우미는 사용자 컴퓨터에서 직접 켜는 작은 프로그램이고, 이 브라우저만 127.0.0.1 로 연결한다.
 * 사이트 서버는 명령을 실행하지도, 연결 코드를 알지도 못한다 (연결 코드는 이 브라우저에만 저장).
 */

export const DEFAULT_RUNNER_PORT = 47821;
const KEY = 'runner-connection';

export interface RunnerConnection {
  port: number;
  token: string;
}

export interface RunnerInfo {
  folder: string;
  platform: string;
  shell: string;
}

export interface RunnerResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  ms: number;
  platform: string;
  shell: string;
}

export function loadRunnerConnection(): RunnerConnection | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<RunnerConnection> | null;
    if (v && typeof v.token === 'string' && v.token && Number.isInteger(v.port)) return { port: v.port!, token: v.token };
  } catch {
    /* 저장된 게 없거나 깨졌다 */
  }
  return null;
}

export function saveRunnerConnection(conn: RunnerConnection | null): void {
  try {
    if (conn) localStorage.setItem(KEY, JSON.stringify(conn));
    else localStorage.removeItem(KEY);
  } catch {
    /* 기억하지 못해도 지금 화면에서는 쓸 수 있다 */
  }
}

export class RunnerError extends Error {}

async function call<T>(conn: RunnerConnection, path: string, init?: { body?: unknown; timeoutMs: number }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${conn.port}${path}`, {
      method: init?.body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${conn.token}`, ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init?.timeoutMs ?? 5000),
    });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') throw new RunnerError('도우미가 응답하지 않아요');
    throw new RunnerError(
      '프로그램 실행 도우미에 연결하지 못했어요. 내 컴퓨터에서 도우미가 켜져 있는지, 브라우저가 "내 컴퓨터 장치 접근"을 막지 않았는지 확인해 주세요',
    );
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new RunnerError(data.error ?? `도우미 오류 (${res.status})`);
  return data;
}

/** 도우미가 켜져 있고 연결 코드가 맞는지 확인하고, 도우미가 지켜보는 폴더 이름 등을 돌려준다 */
export const pingRunner = (conn: RunnerConnection) => call<RunnerInfo & { ok: true }>(conn, '/ping');

export const runOnRunner = (conn: RunnerConnection, body: { command: string; cwd?: string; timeoutSec?: number }) =>
  call<RunnerResult>(conn, '/run', { body, timeoutMs: ((body.timeoutSec ?? 120) + 15) * 1000 });
