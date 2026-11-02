import type { Schedule, ScheduleRepeat } from './types';

export const WEEKDAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const WORKDAYS = [1, 2, 3, 4, 5];

/** 화면에서 고르는 반복 방식 (평일은 "월~금 매주"를 따로 보여 준다) */
export type RepeatChoice = 'once' | 'daily' | 'workdays' | 'weekly';

export const isWorkdays = (days: number[]) =>
  days.length === WORKDAYS.length && WORKDAYS.every((d) => days.includes(d));

export function choiceOf(repeat: ScheduleRepeat, weekdays: number[]): RepeatChoice {
  if (repeat === 'weekly' && isWorkdays(weekdays)) return 'workdays';
  return repeat;
}

export function toRepeat(choice: RepeatChoice, weekdays: number[]): { repeat: ScheduleRepeat; weekdays: number[] } {
  if (choice === 'workdays') return { repeat: 'weekly', weekdays: WORKDAYS };
  if (choice === 'weekly') return { repeat: 'weekly', weekdays };
  return { repeat: choice, weekdays: [] };
}

/** "09:30" → "오전 9:30" */
export function formatTime(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h < 12 ? '오전' : '오후'} ${h12}:${String(m).padStart(2, '0')}`;
}

/** "매일 오전 9:00", "평일 오전 9:00", "매주 월·수·금 오후 6:00", "10월 20일 (화) 오후 3:00 한 번" */
export function describeSchedule(s: Pick<Schedule, 'repeat' | 'time' | 'weekdays' | 'date'>): string {
  const time = formatTime(s.time);
  if (s.repeat === 'daily') return `매일 ${time}`;
  if (s.repeat === 'weekly') {
    if (isWorkdays(s.weekdays)) return `평일 ${time}`;
    if (s.weekdays.length === 2 && s.weekdays.includes(0) && s.weekdays.includes(6)) return `주말 ${time}`;
    const days = [...s.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]).join('·');
    return `매주 ${days} ${time}`;
  }
  if (!s.date) return time;
  const [y = 0, m = 1, d = 1] = s.date.split('-').map(Number);
  const wd = WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${wd}) ${time} 한 번`;
}

/** 실행 시각: "오늘 오전 9:00", "내일 오후 3:00", "10월 20일 (화) 오후 3:00" */
export function formatRunAt(iso: string, now = new Date()): string {
  const t = new Date(iso);
  const time = formatTime(`${t.getHours()}:${t.getMinutes()}`);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(t) - day(now)) / 86_400_000);
  if (diff === 0) return `오늘 ${time}`;
  if (diff === 1) return `내일 ${time}`;
  if (diff === -1) return `어제 ${time}`;
  return `${t.getMonth() + 1}월 ${t.getDate()}일 (${WEEKDAY_NAMES[t.getDay()]}) ${time}`;
}

/** 브라우저의 시간대 (예: Asia/Seoul) */
export const browserTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
  } catch {
    return 'Asia/Seoul';
  }
};

/** 오늘 날짜 "YYYY-MM-DD" (브라우저 기준) */
export function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
