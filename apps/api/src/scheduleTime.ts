/** 예약 작업의 반복 규칙과 다음 실행 시각 계산 (시간대는 사용자 브라우저 기준) */

export type Repeat = 'once' | 'daily' | 'weekly';

export interface ScheduleSpec {
  repeat: Repeat;
  /** "HH:MM" (24시간) */
  time: string;
  /** weekly 일 때 요일들 (0=일 ~ 6=토) */
  weekdays: number[];
  /** once 일 때 날짜 "YYYY-MM-DD" */
  date: string | null;
  timezone: string;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 그 시간대에서 본 날짜·시각 */
function partsIn(ts: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ts))
      .map((x) => [x.type, x.value]),
  );
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, s: +p.second! };
}

/** 그 시간대가 UTC 보다 몇 ms 앞서는지 (서머타임이 있으면 시각마다 다르다) */
function offsetMs(ts: number, tz: string): number {
  const p = partsIn(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ts / 1000) * 1000;
}

/** 그 시간대의 "y-m-d h:min" 이 실제로 언제인지 */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = offsetMs(guess, tz);
  const ts = guess - first;
  const second = offsetMs(ts, tz);
  return second === first ? ts : guess - second;
}

/** after 보다 뒤의 첫 실행 시각. 더 실행할 일이 없으면(지난 한 번짜리) null */
export function nextRunAt(spec: ScheduleSpec, after: Date): Date | null {
  const [h, min] = spec.time.split(':').map(Number) as [number, number];
  const tz = spec.timezone;
  if (spec.repeat === 'once') {
    if (!spec.date) return null;
    const [y, m, d] = spec.date.split('-').map(Number) as [number, number, number];
    const t = zonedToUtc(y, m, d, h, min, tz);
    return t > after.getTime() ? new Date(t) : null;
  }
  const today = partsIn(after.getTime(), tz);
  // 오늘부터 8일 안에 반드시 한 번은 걸린다 (매주 반복의 요일이 하나뿐이어도)
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    if (spec.repeat === 'weekly' && !spec.weekdays.includes(day.getUTCDay())) continue;
    const t = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, min, tz);
    if (t > after.getTime()) return new Date(t);
  }
  return null;
}
