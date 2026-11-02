import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';

/** 사용량 창 길이. 첫 메시지부터 이 시간이 지나면 사용량이 0 으로 돌아간다 (Claude 방식) */
export const WINDOW_HOURS = 5;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

const DEFAULT_LIMIT_KEY = 'default_token_limit';

/** 관리자가 정한 기본 사용량 (없으면 .env 의 TOKEN_LIMIT_DEFAULT) */
export async function getDefaultLimit(): Promise<number> {
  const { rows } = await pool.query<{ value: unknown }>('select value from app_settings where key = $1', [
    DEFAULT_LIMIT_KEY,
  ]);
  const v = rows[0]?.value;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : config.TOKEN_LIMIT_DEFAULT;
}

export async function setDefaultLimit(limit: number): Promise<void> {
  await pool.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [DEFAULT_LIMIT_KEY, JSON.stringify(limit)],
  );
}

export interface Usage {
  /** 5시간 동안 쓸 수 있는 토큰 수 */
  limit: number;
  /** 사용자에게 따로 정한 값이면 true, 사이트 기본값이면 false */
  custom: boolean;
  /** 지금 창에서 쓴 토큰 수 (질문 + 답변) */
  used: number;
  /** 지금 창이 끝나는 시각. 창이 없으면(5시간 넘게 안 썼으면) null → 다음 메시지부터 새로 시작 */
  resetAt: string | null;
  windowHours: number;
}

interface UsageRow {
  token_limit: number | null;
  usage_window_start: Date | null;
  used: string | null;
}

const toUsage = (row: UsageRow, defaultLimit: number, now = Date.now()): Usage => {
  const start = row.usage_window_start;
  const active = !!start && now - start.getTime() < WINDOW_MS;
  return {
    limit: row.token_limit ?? defaultLimit,
    custom: row.token_limit !== null,
    used: active ? Number(row.used ?? 0) : 0,
    resetAt: active ? new Date(start.getTime() + WINDOW_MS).toISOString() : null,
    windowHours: WINDOW_HOURS,
  };
};

// 창 시작 이후의 사용량 합계. 창이 끝났으면 계산할 필요 없이 0 이다
const USAGE_SELECT = `
  select u.id, u.token_limit, u.usage_window_start,
         (select sum(l.prompt_tokens + l.completion_tokens) from usage_logs l
           where l.user_id = u.id and u.usage_window_start is not null
             and l.created_at >= u.usage_window_start) as used
  from users u`;

/** 사용량 조회 (창을 새로 시작하지는 않는다) */
export async function getUsage(userId: string): Promise<Usage> {
  const [defaultLimit, { rows }] = await Promise.all([
    getDefaultLimit(),
    pool.query<UsageRow>(`${USAGE_SELECT} where u.id = $1`, [userId]),
  ]);
  if (!rows[0]) throw new HttpError(401, '로그인이 필요해요');
  return toUsage(rows[0], defaultLimit);
}

/** 관리자 화면용: 모든 사용자의 사용량 */
export async function listUsage(): Promise<Map<string, Usage>> {
  const [defaultLimit, { rows }] = await Promise.all([
    getDefaultLimit(),
    pool.query<UsageRow & { id: string }>(USAGE_SELECT),
  ]);
  const now = Date.now();
  return new Map(rows.map((r) => [r.id, toUsage(r, defaultLimit, now)]));
}

/** "10월 13일 오후 6:54" (Node 의 한국어 날짜 형식이 환경마다 달라서 직접 만든다) */
function formatReset(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${parts.month}월 ${parts.day}일 ${hour < 12 ? '오전' : '오후'} ${h12}:${parts.minute}`;
}

/**
 * 메시지를 보내기 전에 호출한다. 남은 사용량이 없으면 429 를 던진다.
 * 창이 없거나 끝났으면 지금부터 새 5시간 창을 시작한다.
 */
export async function checkAndStartWindow(userId: string): Promise<Usage> {
  const usage = await getUsage(userId);
  if (usage.limit === 0) throw new HttpError(429, '관리자가 이 계정의 사용을 막아 두었어요.');
  if (usage.resetAt === null) {
    await pool.query('update users set usage_window_start = now() where id = $1', [userId]);
    return { ...usage, used: 0, resetAt: new Date(Date.now() + WINDOW_MS).toISOString() };
  }
  if (usage.used >= usage.limit) {
    throw new HttpError(
      429,
      `${WINDOW_HOURS}시간 사용량을 모두 썼어요. ${formatReset(usage.resetAt)}에 다시 쓸 수 있어요.`,
    );
  }
  return usage;
}

/** 관리자가 사용량을 바로 0 으로 되돌린다 (다음 메시지부터 새 창) */
export async function resetUsage(userId: string): Promise<void> {
  await pool.query('update users set usage_window_start = null where id = $1', [userId]);
}
