import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BellIcon, ClockIcon, GlobeIcon, MailIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { ErrorBox, PrimaryButton, SecondaryButton, inputClass } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import {
  WEEKDAY_NAMES,
  browserTimezone,
  choiceOf,
  describeSchedule,
  formatRunAt,
  toRepeat,
  todayString,
  type RepeatChoice,
} from '../lib/schedule';
import type { Schedule, ScheduleInput } from '../lib/types';
import { useChats } from '../store/chats';
import { useModels } from '../store/models';
import { useStyles } from '../store/styles';
import { useGoogle } from '../store/google';
import { useWebSearch } from '../store/webSearch';

interface ListResponse {
  items: Schedule[];
  max: number;
}

const REPEAT_CHOICES: { id: RepeatChoice; label: string }[] = [
  { id: 'daily', label: '매일' },
  { id: 'workdays', label: '평일' },
  { id: 'weekly', label: '요일 고르기' },
  { id: 'once', label: '한 번만' },
];

const EXAMPLES: { title: string; prompt: string; web?: boolean; gmail?: boolean }[] = [
  {
    title: '아침 메일 요약',
    prompt: '어제부터 온 안 읽은 메일을 찾아서 보낸 사람·제목·핵심 내용과 내가 해야 할 일을 정리해 줘. 광고 메일은 빼 줘.',
    gmail: true,
  },
  {
    title: '아침 뉴스 요약',
    prompt: '오늘 국내외 주요 뉴스 5개를 웹에서 찾아 한두 줄씩 요약하고, 각각 출처 링크를 붙여 줘.',
    web: true,
  },
  { title: '오늘의 영어 표현', prompt: '오늘 써먹을 만한 영어 표현 3개를 뜻, 예문, 쓰는 상황과 함께 알려줘.' },
  { title: '주간 회고 질문', prompt: '한 주를 돌아보는 회고 질문 5개를 만들어 줘. 매번 조금씩 다른 관점으로.' },
  { title: '오늘의 코딩 문제', prompt: '파이썬 초급~중급 코딩 문제 하나를 내 줘. 정답 코드는 맨 아래에 따로 적어 줘.' },
];

const emptyForm = (): ScheduleInput => ({
  title: '',
  prompt: '',
  model: null,
  styleId: null,
  repeat: 'daily',
  time: '09:00',
  weekdays: [],
  date: todayString(),
  timezone: browserTimezone(),
  enabled: true,
  webSearch: false,
  gmail: false,
});

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-2xl border border-sand-200 bg-white p-5 shadow-[0_1px_3px_0] shadow-sand-900/5 dark:border-sand-800 dark:bg-sand-800/50 ${className}`}
    >
      {children}
    </section>
  );
}

function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-sand-700 dark:text-sand-300">
      {children}
    </label>
  );
}

const chipClass = (on: boolean) =>
  `rounded-lg border px-3 py-1.5 text-sm transition-colors ${
    on
      ? 'border-clay-500 bg-clay-50 font-medium text-clay-700 dark:bg-clay-950/40 dark:text-clay-300'
      : 'border-sand-300 text-sand-600 hover:bg-sand-100 dark:border-sand-600 dark:text-sand-300 dark:hover:bg-sand-700'
  }`;

/** 만들기 / 고치기 양식 */
function ScheduleForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: Schedule | null;
  onCancel(): void;
  onSaved(s: Schedule): void;
}) {
  const ids = { title: useId(), prompt: useId(), time: useId(), date: useId(), model: useId(), style: useId() };
  const [form, setForm] = useState<ScheduleInput>(() =>
    initial
      ? { ...initial, date: initial.date ?? todayString() }
      : emptyForm(),
  );
  const [choice, setChoice] = useState<RepeatChoice>(initial ? choiceOf(initial.repeat, initial.weekdays) : 'daily');
  const [days, setDays] = useState<number[]>(initial?.repeat === 'weekly' ? initial.weekdays : [1]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const models = useModels((s) => s.models);
  const presets = useStyles((s) => s.presets);
  const custom = useStyles((s) => s.custom);
  const webAvailable = useWebSearch((s) => s.available);
  const gmailConnected = useGoogle((s) => !!s.status?.gmail);

  const set =<K extends keyof ScheduleInput>(key: K, value: ScheduleInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleDay = (d: number) => setDays((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const body: ScheduleInput = {
      ...form,
      ...toRepeat(choice, days),
      date: choice === 'once' ? form.date : null,
      // 고칠 때도 지금 브라우저의 시간대로 맞춘다
      timezone: browserTimezone(),
    };
    setBusy(true);
    setError(null);
    try {
      const { schedule } = initial
        ? await api<{ schedule: Schedule }>(`/schedules/${initial.id}`, { method: 'PUT', body })
        : await api<{ schedule: Schedule }>('/schedules', { body });
      onSaved(schedule);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={onSubmit} className="space-y-4">
        <h2 className="text-base font-semibold">{initial ? '예약 작업 고치기' : '새 예약 작업'}</h2>

        {!initial && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-sand-500">예시:</span>
            {EXAMPLES.filter((ex) => (!ex.web || webAvailable) && (!ex.gmail || gmailConnected)).map((ex) => (
              <button
                key={ex.title}
                type="button"
                onClick={() => setForm((f) => ({ ...f, title: ex.title, prompt: ex.prompt, webSearch: !!ex.web, gmail: !!ex.gmail }))}
                className="rounded-lg border border-sand-300 px-2.5 py-1 text-xs text-sand-600 hover:bg-sand-100 dark:border-sand-600 dark:text-sand-300 dark:hover:bg-sand-700"
              >
                {ex.title}
              </button>
            ))}
          </div>
        )}

        <div>
          <Label htmlFor={ids.title}>이름</Label>
          <input
            id={ids.title}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            maxLength={60}
            placeholder="예: 오늘의 영어 표현"
            className={inputClass}
            required
          />
          <p className="mt-1.5 text-xs text-sand-500">결과 대화의 제목이 돼요.</p>
        </div>

        <div>
          <Label htmlFor={ids.prompt}>AI 에게 보낼 지시</Label>
          <textarea
            id={ids.prompt}
            value={form.prompt}
            onChange={(e) => set('prompt', e.target.value)}
            rows={4}
            placeholder="예: 오늘 써먹을 만한 영어 표현 3개를 예문과 함께 알려줘."
            className={`${inputClass} resize-y`}
            required
          />
          {webAvailable ? (
            <label className="mt-2.5 flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={form.webSearch}
                onChange={(e) => set('webSearch', e.target.checked)}
                className="mt-0.5 size-4 accent-clay-600"
              />
              <span>
                <span className="flex items-center gap-1.5 font-medium">
                  <GlobeIcon size={14} className="text-sand-500" /> 웹 검색 사용
                </span>
                <span className="mt-0.5 block text-xs text-sand-500">
                  뉴스 요약·가격 확인처럼 최신 정보가 필요한 일이면 켜세요. 출처 링크가 함께 남아요.
                </span>
              </span>
            </label>
          ) : (
            <p className="mt-1.5 text-xs text-sand-500">
              AI 는 인터넷을 볼 수 없어요. 뉴스·날씨처럼 바깥 정보가 필요한 일 대신 글쓰기·정리·문제 내기 같은 일에 쓰세요.
            </p>
          )}
          {gmailConnected && (
            <label className="mt-2.5 flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={form.gmail}
                onChange={(e) => set('gmail', e.target.checked)}
                className="mt-0.5 size-4 accent-clay-600"
              />
              <span>
                <span className="flex items-center gap-1.5 font-medium">
                  <MailIcon size={14} className="text-sand-500" /> Gmail 사용
                </span>
                <span className="mt-0.5 block text-xs text-sand-500">
                  메일 요약처럼 내 Gmail 을 읽어야 하는 일이면 켜세요 (읽기만 해요). 메일을 읽은 뒤에는 그 실행에서 웹 검색을 쓰지 않아요.
                </span>
              </span>
            </label>
          )}
        </div>

        <div>
          <Label>반복</Label>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="반복">
            {REPEAT_CHOICES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={choice === c.id}
                onClick={() => setChoice(c.id)}
                className={chipClass(choice === c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
          {choice === 'weekly' && (
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="요일">
              {WEEKDAY_NAMES.map((name, d) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={days.includes(d)}
                  onClick={() => toggleDay(d)}
                  className={`${chipClass(days.includes(d))} w-10 px-0`}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-4">
          {choice === 'once' && (
            <div>
              <Label htmlFor={ids.date}>날짜</Label>
              <input
                id={ids.date}
                type="date"
                value={form.date ?? ''}
                min={todayString()}
                onChange={(e) => set('date', e.target.value)}
                className={`${inputClass} w-auto`}
                required
              />
            </div>
          )}
          <div>
            <Label htmlFor={ids.time}>시각</Label>
            <input
              id={ids.time}
              type="time"
              value={form.time}
              onChange={(e) => set('time', e.target.value)}
              className={`${inputClass} w-auto`}
              required
            />
          </div>
          {models.length > 1 && (
            <div>
              <Label htmlFor={ids.model}>모델</Label>
              <select
                id={ids.model}
                value={form.model ?? ''}
                onChange={(e) => set('model', e.target.value || null)}
                className={`${inputClass} w-auto`}
              >
                <option value="">기본 모델</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <Label htmlFor={ids.style}>응답 스타일</Label>
            <select
              id={ids.style}
              value={form.styleId ?? ''}
              onChange={(e) => set('styleId', e.target.value || null)}
              className={`${inputClass} w-auto`}
            >
              <option value="">내가 고른 스타일 따르기</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {custom.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (내 스타일)
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && <ErrorBox>{error}</ErrorBox>}

        <div className="flex items-center gap-2">
          <PrimaryButton type="submit" disabled={busy}>
            {busy ? '저장 중…' : initial ? '저장' : '만들기'}
          </PrimaryButton>
          <SecondaryButton type="button" onClick={onCancel} disabled={busy}>
            취소
          </SecondaryButton>
        </div>
      </form>
    </Card>
  );
}

/** 켜기/끄기 스위치 */
function Toggle({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange(v: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={on ? '켜져 있어요 (누르면 꺼짐)' : '꺼져 있어요 (누르면 켜짐)'}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? 'bg-clay-500' : 'bg-sand-300 dark:bg-sand-600'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`}
      />
    </button>
  );
}

function LastResult({ s }: { s: Schedule }) {
  if (s.running) {
    return <span className="text-clay-600 dark:text-clay-400">지금 실행 중… 끝나면 새 대화로 생겨요</span>;
  }
  if (!s.lastRunAt || !s.lastStatus) return <span className="text-sand-400">아직 실행한 적 없어요</span>;
  const when = formatRunAt(s.lastRunAt);
  if (s.lastStatus === 'skipped') {
    return (
      <span className="text-amber-700 dark:text-amber-400" title={s.lastMessage ?? ''}>
        {when} 건너뜀 — {s.lastMessage}
      </span>
    );
  }
  return (
    <span className={s.lastStatus === 'error' ? 'text-red-600 dark:text-red-400' : 'text-sand-600 dark:text-sand-300'}>
      {when} {s.lastStatus === 'error' ? `실패${s.lastMessage ? ` — ${s.lastMessage}` : ''}` : '완료'}
      {s.lastConversationId && (
        <>
          {' · '}
          <Link to={`/chat/${s.lastConversationId}`} className="font-medium text-clay-600 underline-offset-2 hover:underline dark:text-clay-400">
            결과 보기
          </Link>
        </>
      )}
    </span>
  );
}

function ScheduleItem({
  s,
  onChange,
  onEdit,
  onDeleted,
}: {
  s: Schedule;
  onChange(s: Schedule): void;
  onEdit(): void;
  onDeleted(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (enabled: boolean) =>
    run(async () => {
      const { schedule } = await api<{ schedule: Schedule }>(`/schedules/${s.id}`, { method: 'PATCH', body: { enabled } });
      onChange(schedule);
    });

  const runNow = () =>
    run(async () => {
      const { schedule } = await api<{ schedule: Schedule }>(`/schedules/${s.id}/run`, { method: 'POST' });
      onChange(schedule);
    });

  const remove = () => {
    if (!window.confirm(`"${s.title}" 예약 작업을 지울까요? 이미 만들어진 결과 대화는 남아요.`)) return;
    void run(async () => {
      await api(`/schedules/${s.id}`, { method: 'DELETE' });
      onDeleted();
    });
  };

  return (
    <Card className={s.enabled ? '' : 'opacity-75'}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold" title={s.title}>
            {s.title}
          </h3>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-sand-600 dark:text-sand-300">
            <ClockIcon size={14} className="shrink-0 text-sand-400" />
            {describeSchedule(s)}
            {s.webSearch && (
              <span className="ml-1 flex items-center gap-1 rounded-md bg-sand-100 px-1.5 py-0.5 text-xs text-sand-600 dark:bg-sand-700 dark:text-sand-300">
                <GlobeIcon size={12} /> 웹 검색
              </span>
            )}
            {s.gmail && (
              <span className="flex items-center gap-1 rounded-md bg-sand-100 px-1.5 py-0.5 text-xs text-sand-600 dark:bg-sand-700 dark:text-sand-300">
                <MailIcon size={12} /> Gmail
              </span>
            )}
          </p>
        </div>
        <Toggle on={s.enabled} disabled={busy} label={`${s.title} 켜기`} onChange={(v) => void toggle(v)} />
      </div>

      <p className="mt-3 line-clamp-2 text-sm whitespace-pre-line text-sand-500 dark:text-sand-400" title={s.prompt}>
        {s.prompt}
      </p>

      <dl className="mt-3 space-y-1 text-[13px]">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-sand-400">다음 실행</dt>
          <dd className="text-sand-700 dark:text-sand-200">
            {s.enabled && s.nextRunAt ? formatRunAt(s.nextRunAt) : <span className="text-sand-400">꺼져 있음</span>}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-sand-400">지난 실행</dt>
          <dd className="min-w-0">
            <LastResult s={s} />
          </dd>
        </div>
      </dl>

      {error && (
        <div className="mt-3">
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <SecondaryButton type="button" onClick={() => void runNow()} disabled={busy || s.running} className="flex items-center gap-1.5 px-3 py-1.5">
          <PlayIcon size={14} /> 지금 실행
        </SecondaryButton>
        <SecondaryButton type="button" onClick={onEdit} disabled={busy} className="flex items-center gap-1.5 px-3 py-1.5">
          <PencilIcon size={14} /> 고치기
        </SecondaryButton>
        <SecondaryButton
          type="button"
          onClick={remove}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 hover:text-red-600 dark:hover:text-red-400"
        >
          <TrashIcon size={14} /> 지우기
        </SecondaryButton>
      </div>
    </Card>
  );
}

/** 결과가 나오면 브라우저 알림을 받을지 */
function NotificationBanner() {
  const supported = typeof Notification !== 'undefined';
  const [permission, setPermission] = useState(supported ? Notification.permission : 'denied');
  if (!supported || permission === 'granted') return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-sand-200 bg-sand-100/60 px-4 py-3 text-sm dark:border-sand-800 dark:bg-sand-800/40">
      <BellIcon size={18} className="shrink-0 text-sand-500" />
      <span className="min-w-0 flex-1 text-sand-600 dark:text-sand-300">
        {permission === 'denied'
          ? '이 브라우저에서 알림이 막혀 있어요. 주소창 왼쪽의 사이트 설정에서 알림을 허용하면 결과가 나올 때 알려 드려요.'
          : '결과가 나오면 브라우저 알림으로 알려 드릴까요? (사이트를 열어 둔 동안만)'}
      </span>
      {permission === 'default' && (
        <PrimaryButton
          type="button"
          onClick={() => void Notification.requestPermission().then(setPermission)}
          className="px-3 py-1.5"
        >
          알림 받기
        </PrimaryButton>
      )}
    </div>
  );
}

export default function Schedules() {
  const [items, setItems] = useState<Schedule[] | null>(null);
  const [max, setMax] = useState(10);
  const [error, setError] = useState<string | null>(null);
  // null: 양식 닫힘, 'new': 새로 만들기, 그 밖: 고치는 예약 작업 id
  const [editing, setEditing] = useState<string | null>(null);
  const stylesLoaded = useStyles((s) => s.loaded);

  const load = async () => {
    try {
      const data = await api<ListResponse>('/schedules');
      setItems(data.items);
      setMax(data.max);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
    if (!stylesLoaded) void useStyles.getState().load().catch(() => {});
  }, [stylesLoaded]);

  // 실행 중인 작업이 있으면 끝날 때까지 5초마다 다시 읽고, 끝나면 사이드바에도 새 대화를 반영한다
  const anyRunning = items?.some((s) => s.running) ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => {
      void load().then(() => useChats.getState().refresh());
    }, 5000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const replace = (s: Schedule) => setItems((list) => list?.map((x) => (x.id === s.id ? s : x)) ?? [s]);
  const full = items !== null && items.length >= max;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 pb-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">예약 작업</h1>
            <p className="mt-1 text-sm text-sand-500">
              정해 둔 시각에 AI 가 지시대로 일하고, 결과를 새 대화로 남겨 둬요. 사이트를 닫아 둬도 실행돼요.
            </p>
          </div>
          {editing === null && (
            <PrimaryButton
              type="button"
              onClick={() => setEditing('new')}
              disabled={full}
              title={full ? `예약 작업은 ${max}개까지 만들 수 있어요` : undefined}
              className="flex items-center gap-1.5"
            >
              <PlusIcon size={16} strokeWidth={2.5} /> 새 예약
            </PrimaryButton>
          )}
        </div>

        <NotificationBanner />
        {error && <ErrorBox>{error}</ErrorBox>}
        {items === null && !error && <p className="text-sm text-sand-500">불러오는 중…</p>}

        {editing === 'new' && (
          <ScheduleForm
            initial={null}
            onCancel={() => setEditing(null)}
            onSaved={(s) => {
              setItems((list) => [...(list ?? []), s]);
              setEditing(null);
            }}
          />
        )}

        {items?.length === 0 && editing !== 'new' && (
          <Card className="text-center">
            <ClockIcon size={28} className="mx-auto text-sand-400" />
            <p className="mt-2 font-medium">아직 예약 작업이 없어요</p>
            <p className="mt-1 text-sm text-sand-500">
              {max === 0 ? '관리자가 예약 작업을 막아 두었어요.' : '"새 예약"으로 매일 아침 받아 볼 글이나 정리를 맡겨 보세요.'}
            </p>
          </Card>
        )}

        {items?.map((s) =>
          editing === s.id ? (
            <ScheduleForm
              key={s.id}
              initial={s}
              onCancel={() => setEditing(null)}
              onSaved={(saved) => {
                replace(saved);
                setEditing(null);
              }}
            />
          ) : (
            <ScheduleItem
              key={s.id}
              s={s}
              onChange={replace}
              onEdit={() => setEditing(s.id)}
              onDeleted={() => setItems((list) => list?.filter((x) => x.id !== s.id) ?? null)}
            />
          ),
        )}

        {items && items.length > 0 && (
          <p className="text-center text-xs text-sand-400">
            {items.length} / {max}개 · 시각은 이 브라우저의 시간대({browserTimezone()}) 기준이에요
          </p>
        )}
      </div>
    </div>
  );
}
