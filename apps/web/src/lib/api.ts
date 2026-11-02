import type { User } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// 액세스 토큰은 메모리에만 둔다 (localStorage 에 두지 않음 → XSS 로 토큰이 털리는 것을 줄임).
// 새로고침하면 httpOnly 쿠키의 리프레시 토큰으로 다시 받는다.
let accessToken: string | null = null;
let onAuthLost: () => void = () => {};

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const setAuthLostHandler = (fn: () => void) => {
  onAuthLost = fn;
};

let refreshing: Promise<User | null> | null = null;

/** 리프레시 쿠키로 새 액세스 토큰을 받는다. 동시에 여러 번 불러도 요청은 한 번만 나간다. */
export function refreshSession(): Promise<User | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (!res.ok) return null;
        const data = (await res.json()) as { accessToken: string; user: User };
        accessToken = data.accessToken;
        return data.user;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** 토큰을 붙여 호출하고, 401 이면 토큰을 갱신해 한 번 다시 시도한다. */
export async function authedFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('서버에 연결할 수 없어요. 네트워크를 확인해 주세요.', 0);
  }

  if (res.status === 401 && retry) {
    if (await refreshSession()) return authedFetch(path, init, false);
    onAuthLost();
  }
  return res;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** 로그인/가입처럼 401 이 "인증 실패" 그 자체인 요청은 토큰 갱신을 시도하지 않는다 */
  noRefresh?: boolean;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await authedFetch(
    path,
    {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    },
    !opts.noRefresh,
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(data?.error ?? `요청에 실패했어요 (${res.status})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const errorMessage = (err: unknown, fallback = '문제가 생겼어요. 잠시 후 다시 시도해 주세요.') =>
  err instanceof Error && err.message ? err.message : fallback;
