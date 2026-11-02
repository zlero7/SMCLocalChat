import { useEffect, useState } from 'react';
import {
  DEFAULT_RUNNER_PORT,
  loadRunnerConnection,
  pingRunner,
  saveRunnerConnection,
  type RunnerConnection,
  type RunnerInfo,
} from '../lib/runner';
import { ErrorBox, PrimaryButton, SecondaryButton } from './ui';

type Status = { kind: 'none' } | { kind: 'checking' } | { kind: 'ok'; info: RunnerInfo } | { kind: 'fail'; message: string };

/** 설정의 "프로그램 실행" 칸: 내 컴퓨터에서 켠 도우미와 연결한다 */
export function RunnerSettings() {
  const [conn, setConn] = useState<RunnerConnection | null>(() => loadRunnerConnection());
  const [token, setToken] = useState('');
  const [port, setPort] = useState(String(DEFAULT_RUNNER_PORT));
  const [status, setStatus] = useState<Status>({ kind: 'none' });

  const check = async (c: RunnerConnection) => {
    setStatus({ kind: 'checking' });
    try {
      setStatus({ kind: 'ok', info: await pingRunner(c) });
    } catch (err) {
      setStatus({ kind: 'fail', message: (err as Error).message });
    }
  };

  useEffect(() => {
    if (conn) void check(conn);
    // 처음 열 때 한 번만 확인한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = { port: Number(port), token: token.trim() };
    if (!next.token || !Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) {
      return setStatus({ kind: 'fail', message: '연결 코드와 포트(1024~65535)를 확인해 주세요' });
    }
    setStatus({ kind: 'checking' });
    try {
      const info = await pingRunner(next);
      saveRunnerConnection(next);
      setConn(next);
      setToken('');
      setStatus({ kind: 'ok', info });
    } catch (err) {
      setStatus({ kind: 'fail', message: (err as Error).message });
    }
  };

  const disconnect = () => {
    saveRunnerConnection(null);
    setConn(null);
    setStatus({ kind: 'none' });
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5 leading-relaxed text-sand-500 dark:text-sand-400">
        <p>
          AI 가 <b>내 컴퓨터의 작업 폴더</b>에서 프로그램(python, npm, git 등)을 실행하게 하려면, 내 컴퓨터에서 작은 도우미를 켜야 해요. 이 사이트의
          서버는 명령을 실행하지 않아요.
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            <a href="/chat-site-runner.mjs" download className="font-medium text-clay-600 underline dark:text-clay-400">
              도우미 파일 받기
            </a>{' '}
            (Node.js 18 이상 필요)
          </li>
          <li>
            AI 에게 맡길 폴더에서 켜기: <code className="rounded bg-sand-100 px-1 py-0.5 dark:bg-sand-700">node chat-site-runner.mjs "폴더 경로"</code>
          </li>
          <li>창에 나온 <b>연결 코드</b>를 아래에 붙여 넣기 (한 번만 하면 돼요)</li>
          <li>채팅에서 <b>같은 폴더</b>를 열고, 명령은 입력창의 "권한"에 따라 허용을 물어요</li>
        </ol>
        <p className="text-xs">
          명령은 허용한 것만 실행되고 시간 제한이 있어요. 믿는 폴더에서만 켜고, 허용 카드의 명령을 꼭 읽어 보세요. 파일 속 글이 AI 를 속여 명령을 시킬 수도
          있어요.
        </p>
      </div>

      {status.kind === 'ok' && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          연결됐어요 — 폴더 "{status.info.folder}" · {status.info.platform === 'win32' ? 'Windows' : status.info.platform}
        </p>
      )}
      {status.kind === 'checking' && <p className="text-sand-500">확인하는 중…</p>}
      {status.kind === 'fail' && <ErrorBox>{status.message}</ErrorBox>}

      {conn ? (
        <div className="flex flex-wrap gap-2">
          <SecondaryButton type="button" onClick={() => void check(conn)}>
            다시 확인
          </SecondaryButton>
          <SecondaryButton type="button" onClick={disconnect}>
            연결 끊기
          </SecondaryButton>
        </div>
      ) : (
        <form onSubmit={connect} className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-xs text-sand-500">연결 코드</span>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-sand-300 bg-white px-3 py-2 font-mono dark:border-sand-600 dark:bg-sand-900"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs text-sand-500">포트</span>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
              className="w-24 rounded-lg border border-sand-300 bg-white px-3 py-2 dark:border-sand-600 dark:bg-sand-900"
            />
          </label>
          <PrimaryButton type="submit" disabled={!token.trim()}>
            연결
          </PrimaryButton>
        </form>
      )}
    </div>
  );
}
