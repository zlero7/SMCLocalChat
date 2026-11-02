import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { UsageBar } from '../components/UsageBar';
import { ErrorBox, PrimaryButton, SecondaryButton, inputClass } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { AdminUser, Usage } from '../lib/types';
import { useAuth } from '../store/auth';
import { formatTokens, useUsage } from '../store/usage';

interface AdminSettings {
  defaultTokenLimit: number;
  windowHours: number;
  /** 사용자 한 명이 만들 수 있는 예약 작업 수 */
  maxSchedules: number;
}

const QUICK_LIMITS = [50_000, 100_000, 200_000, 500_000];

// 한 줄에 여러 개 놓는 입력칸 (공용 스타일의 w-full 을 빼고 너비를 따로 준다)
const inlineInput = inputClass.replace('w-full ', '');

function Card({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-sand-200 bg-white p-5 shadow-[0_1px_3px_0] shadow-sand-900/5 sm:p-6 dark:border-sand-800 dark:bg-sand-800/50">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm leading-relaxed text-sand-500 dark:text-sand-400">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** 숫자 입력 (쉼표 허용) → 정수. 비었거나 이상하면 null */
const parseLimit = (text: string): number | null => {
  const n = Number(text.replace(/[,\s]/g, ''));
  return text.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null;
};

function DefaultLimitCard({ settings, onSaved }: { settings: AdminSettings; onSaved(s: AdminSettings): void }) {
  const [value, setValue] = useState(String(settings.defaultTokenLimit));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const limit = parseLimit(value);
    if (limit === null) return setMessage({ ok: false, text: '0 이상의 정수로 입력해 주세요.' });
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api<AdminSettings>('/admin/settings', { method: 'PUT', body: { defaultTokenLimit: limit } });
      onSaved(saved);
      setMessage({ ok: true, text: '저장했어요. 개별 한도가 없는 모든 사용자에게 바로 적용돼요.' });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={`기본 사용량 (${settings.windowHours}시간마다 초기화)`}
      description={
        <>
          사용자 한 명이 {settings.windowHours}시간 동안 쓸 수 있는 토큰(질문 + 답변) 수예요. 대화가 길어질수록 앞 내용까지
          다시 읽기 때문에 한 번에 쓰는 양이 늘어나요. 보통 한 번 주고받는 데 2천~5천 토큰쯤 써요.
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="numeric"
            aria-label="기본 사용량 (토큰)"
            className={`${inlineInput} w-40 tabular-nums`}
          />
          <span className="text-sm text-sand-500">토큰</span>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_LIMITS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setValue(String(n))}
                className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                  parseLimit(value) === n
                    ? 'border-clay-500 bg-clay-50 text-clay-700 dark:bg-clay-950/40 dark:text-clay-300'
                    : 'border-sand-300 text-sand-600 hover:bg-sand-100 dark:border-sand-600 dark:text-sand-300 dark:hover:bg-sand-700'
                }`}
              >
                {formatTokens(n)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <PrimaryButton type="submit" disabled={busy}>
            {busy ? '저장 중…' : '저장'}
          </PrimaryButton>
          {message && (
            <span
              role="status"
              className={`text-sm ${message.ok ? 'text-clay-600 dark:text-clay-400' : 'text-red-600 dark:text-red-400'}`}
            >
              {message.text}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function ScheduleLimitCard({ settings, onSaved }: { settings: AdminSettings; onSaved(s: AdminSettings): void }) {
  const [value, setValue] = useState(String(settings.maxSchedules));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const n = parseLimit(value);
    if (n === null || n > 100) return setMessage({ ok: false, text: '0 ~ 100 사이의 정수로 입력해 주세요.' });
    setBusy(true);
    setMessage(null);
    try {
      onSaved(await api<AdminSettings>('/admin/settings', { method: 'PUT', body: { maxSchedules: n } }));
      setMessage({ ok: true, text: '저장했어요. 이미 만든 예약 작업은 그대로 두고, 새로 만들 때부터 적용돼요.' });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="예약 작업 개수"
      description="사용자 한 명이 만들 수 있는 예약 작업 수예요. 0 이면 예약 기능을 막아요. 예약 실행도 각자의 사용량에서 빠져요."
    >
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="numeric"
          aria-label="사용자당 예약 작업 수"
          className={`${inlineInput} w-24 tabular-nums`}
        />
        <span className="text-sm text-sand-500">개</span>
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? '저장 중…' : '저장'}
        </PrimaryButton>
        {message && (
          <span
            role="status"
            className={`text-sm ${message.ok ? 'text-clay-600 dark:text-clay-400' : 'text-red-600 dark:text-red-400'}`}
          >
            {message.text}
          </span>
        )}
      </form>
    </Card>
  );
}

function UserRow({ user, onUsage }: { user: AdminUser; onUsage(id: string, usage: Usage): void }) {
  const me = useAuth((s) => s.user);
  const [mode, setMode] = useState<'default' | 'custom'>(user.usage.custom ? 'custom' : 'default');
  const [value, setValue] = useState(user.usage.custom ? String(user.usage.limit) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const run = async (fn: () => Promise<Usage>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const usage = await fn();
      onUsage(user.id, usage);
      setSaved(true);
      // 내 한도를 바꿨으면 입력창 위 알림에도 바로 반영
      if (user.id === me?.id) void useUsage.getState().refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      let tokenLimit: number | null = null;
      if (mode === 'custom') {
        tokenLimit = parseLimit(value);
        if (tokenLimit === null) throw new Error('0 이상의 정수로 입력해 주세요.');
      }
      return (await api<{ usage: Usage }>(`/admin/users/${user.id}`, { method: 'PATCH', body: { tokenLimit } })).usage;
    });

  const resetUsage = () => {
    if (!window.confirm(`${user.nickname}님의 사용량을 지금 0으로 되돌릴까요?`)) return;
    void run(async () => (await api<{ usage: Usage }>(`/admin/users/${user.id}/reset-usage`, { method: 'POST' })).usage);
  };

  const [resetLink, setResetLink] = useState<string | null>(null);
  const makeResetLink = async () => {
    if (!window.confirm(`${user.nickname}님의 비밀번호 재설정 링크를 만들까요? 이전 링크는 못 쓰게 돼요.`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ path: string }>(`/admin/users/${user.id}/password-reset`, { method: 'POST' });
      setResetLink(`${window.location.origin}${r.path}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium">{user.nickname}</span>
        {user.role === 'admin' && (
          <span className="rounded-md bg-clay-100 px-1.5 py-0.5 text-[11px] font-medium text-clay-700 dark:bg-clay-950/60 dark:text-clay-300">
            관리자
          </span>
        )}
        <span className="text-sm text-sand-500">{user.email}</span>
        <span className="ml-auto text-xs text-sand-400">
          {user.lastActiveAt ? `최근 사용 ${new Date(user.lastActiveAt).toLocaleString('ko-KR')}` : '아직 사용 안 함'}
        </span>
      </div>

      <div className="mt-2.5">
        <UsageBar usage={user.usage} compact />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as 'default' | 'custom');
            setSaved(false);
          }}
          aria-label={`${user.nickname} 사용량 한도 방식`}
          className={`${inlineInput} w-auto py-1.5 text-sm`}
        >
          <option value="default">기본값 따르기</option>
          <option value="custom">따로 정하기</option>
        </select>
        {mode === 'custom' && (
          <>
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
              inputMode="numeric"
              placeholder="예: 200000"
              aria-label={`${user.nickname} 사용량 한도 (토큰)`}
              className={`${inlineInput} w-32 py-1.5 text-sm tabular-nums`}
            />
            <span className="text-xs text-sand-500">토큰 (0 = 사용 막기)</span>
          </>
        )}
        <PrimaryButton type="button" onClick={() => void save()} disabled={busy} className="px-3 py-1.5">
          저장
        </PrimaryButton>
        <SecondaryButton type="button" onClick={resetUsage} disabled={busy} className="px-3 py-1.5">
          사용량 초기화
        </SecondaryButton>
        <SecondaryButton type="button" onClick={() => void makeResetLink()} disabled={busy} className="px-3 py-1.5">
          비밀번호 재설정 링크
        </SecondaryButton>
        {saved && <span className="text-xs text-clay-600 dark:text-clay-400">반영했어요</span>}
      </div>
      {resetLink && (
        <div className="mt-3 rounded-lg bg-sand-100 p-3 text-xs dark:bg-sand-800">
          <p className="mb-1 text-sand-500">1시간 안에 한 번만 쓸 수 있어요. 이 사람에게만 전해 주세요.</p>
          <input readOnly value={resetLink} onFocus={(e) => e.target.select()} className={`${inlineInput} w-full py-1.5 font-mono`} />
        </div>
      )}
      {error && (
        <div className="mt-2">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
    </li>
  );
}

export default function Admin() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [s, u] = await Promise.all([
        api<AdminSettings>('/admin/settings'),
        api<{ users: AdminUser[] }>('/admin/users'),
      ]);
      setSettings(s);
      setUsers(u.users);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onUsage = (id: string, usage: Usage) =>
    setUsers((list) => list?.map((u) => (u.id === id ? { ...u, usage } : u)) ?? null);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 pb-12">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">관리자</h1>
          <SecondaryButton type="button" onClick={() => void load()} className="px-3 py-1.5">
            새로고침
          </SecondaryButton>
        </div>

        {error && <ErrorBox>{error}</ErrorBox>}
        {!settings && !error && <p className="text-sm text-sand-500">불러오는 중…</p>}

        {settings && (
          <DefaultLimitCard
            settings={settings}
            onSaved={(s) => {
              setSettings(s);
              void load(); // 기본값을 따르는 사용자들의 한도가 바뀌었으니 다시 읽는다
            }}
          />
        )}

        {settings && <ScheduleLimitCard settings={settings} onSaved={setSettings} />}

        {users && (
          <Card
            title={`사용자 (${users.length}명)`}
            description="사용자마다 따로 한도를 정하면 기본값 대신 그 값을 써요. 사용량 초기화를 누르면 지금 바로 0이 돼요."
          >
            <ul className="divide-y divide-sand-200 dark:divide-sand-700">
              {users.map((u) => (
                <UserRow key={u.id} user={u} onUsage={onUsage} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
