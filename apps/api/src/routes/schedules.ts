import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAuth } from '../middleware.js';
import { isValidTimezone, nextRunAt } from '../scheduleTime.js';
import {
  SCHEDULE_COLUMNS,
  getMaxSchedules,
  isRunning,
  runSchedule,
  specOf,
  type ScheduleRow,
} from '../scheduler.js';
import { isSelectableStyle } from '../styles.js';
import { webSearchConfigured } from '../web/search.js';

export const schedulesRouter = Router();
schedulesRouter.use(requireAuth);

const NOT_FOUND = '예약 작업을 찾을 수 없어요';

function parseId(value: unknown): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(404, NOT_FOUND);
  return parsed.data;
}

const toSchedule = (r: ScheduleRow) => ({
  id: r.id,
  title: r.title,
  prompt: r.prompt,
  model: r.model,
  styleId: r.style_id,
  repeat: r.repeat,
  time: r.time_of_day,
  weekdays: r.weekdays,
  date: r.run_date,
  timezone: r.timezone,
  enabled: r.enabled,
  webSearch: r.web_search,
  gmail: r.gmail,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastStatus: r.last_status,
  lastMessage: r.last_message,
  lastConversationId: r.last_conversation_id,
  running: isRunning(r.id),
  createdAt: r.created_at,
});

async function getOwned(id: string, userId: string): Promise<ScheduleRow> {
  const { rows } = await pool.query<ScheduleRow>(
    `select ${SCHEDULE_COLUMNS} from schedules where id = $1 and user_id = $2`,
    [id, userId],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return rows[0];
}

const scheduleSchema = z
  .object({
    title: z.string().trim().min(1, '이름을 입력해 주세요').max(60, '이름은 60자 이하로 해 주세요'),
    prompt: z
      .string()
      .trim()
      .min(1, '지시를 입력해 주세요')
      .max(config.MAX_MESSAGE_CHARS, `지시는 ${config.MAX_MESSAGE_CHARS}자 이하로 해 주세요`),
    // null 이면 그때그때 사이트 기본 모델 / 내가 고른 기본 스타일
    model: z
      .string()
      .nullable()
      .default(null)
      .refine((id) => id === null || config.MODELS.some((m) => m.id === id), '선택할 수 없는 모델이에요'),
    styleId: z.string().max(100).nullable().default(null),
    repeat: z.enum(['once', 'daily', 'weekly']),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '시각이 올바르지 않아요'),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '날짜가 올바르지 않아요')
      .nullable()
      .default(null),
    timezone: z.string().refine(isValidTimezone, '시간대가 올바르지 않아요'),
    enabled: z.boolean().default(true),
    webSearch: z.boolean().default(false),
    gmail: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.repeat === 'once' && !v.date) ctx.addIssue({ code: 'custom', message: '날짜를 골라 주세요' });
    if (v.repeat === 'weekly' && v.weekdays.length === 0) ctx.addIssue({ code: 'custom', message: '요일을 하나 이상 골라 주세요' });
  });

type ScheduleInput = z.infer<typeof scheduleSchema>;

/** 입력을 검사하고 저장할 값으로 바꾼다 (켜져 있으면 다음 실행 시각까지) */
async function prepare(userId: string, input: ScheduleInput) {
  if (input.webSearch && !webSearchConfigured) throw new HttpError(400, '이 사이트에는 웹 검색이 설정되어 있지 않아요.');
  if (input.gmail) {
    const linked = await pool.query('select 1 from google_accounts where user_id = $1', [userId]);
    if (!linked.rowCount) throw new HttpError(400, 'Gmail 이 연결되어 있지 않아요. 설정에서 먼저 연결해 주세요.');
  }
  if (input.styleId !== null && !(await isSelectableStyle(userId, input.styleId))) {
    throw new HttpError(400, '선택할 수 없는 스타일이에요');
  }
  const weekdays = input.repeat === 'weekly' ? [...new Set(input.weekdays)].sort() : [];
  const date = input.repeat === 'once' ? input.date : null;
  const spec = { repeat: input.repeat, time: input.time, weekdays, date, timezone: input.timezone };
  const next = input.enabled ? nextRunAt(spec, new Date()) : null;
  if (input.enabled && !next) throw new HttpError(400, '이미 지난 시각이에요. 날짜나 시각을 다시 골라 주세요.');
  return { ...input, weekdays, date, next };
}

schedulesRouter.get('/', async (req, res) => {
  const [{ rows }, max] = await Promise.all([
    pool.query<ScheduleRow>(`select ${SCHEDULE_COLUMNS} from schedules where user_id = $1 order by created_at`, [req.user!.id]),
    getMaxSchedules(),
  ]);
  res.json({ items: rows.map(toSchedule), max });
});

schedulesRouter.post('/', async (req, res) => {
  const userId = req.user!.id;
  const v = await prepare(userId, scheduleSchema.parse(req.body));
  const [{ rows: count }, max] = await Promise.all([
    pool.query<{ n: number }>('select count(*)::int as n from schedules where user_id = $1', [userId]),
    getMaxSchedules(),
  ]);
  if ((count[0]?.n ?? 0) >= max) {
    throw new HttpError(400, max === 0 ? '관리자가 예약 작업을 막아 두었어요.' : `예약 작업은 ${max}개까지 만들 수 있어요.`);
  }
  const { rows } = await pool.query<ScheduleRow>(
    `insert into schedules (user_id, title, prompt, model, style_id, repeat, time_of_day, weekdays, run_date, timezone, enabled, next_run_at, web_search, gmail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning ${SCHEDULE_COLUMNS}`,
    [userId, v.title, v.prompt, v.model, v.styleId, v.repeat, v.time, v.weekdays, v.date, v.timezone, v.enabled, v.next, v.webSearch, v.gmail],
  );
  res.status(201).json({ schedule: toSchedule(rows[0]!) });
});

/** 전체 수정 */
schedulesRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const userId = req.user!.id;
  await getOwned(id, userId);
  const v = await prepare(userId, scheduleSchema.parse(req.body));
  const { rows } = await pool.query<ScheduleRow>(
    `update schedules set title = $3, prompt = $4, model = $5, style_id = $6, repeat = $7, time_of_day = $8,
       weekdays = $9, run_date = $10, timezone = $11, enabled = $12, next_run_at = $13, web_search = $14, gmail = $15, updated_at = now()
     where id = $1 and user_id = $2
     returning ${SCHEDULE_COLUMNS}`,
    [id, userId, v.title, v.prompt, v.model, v.styleId, v.repeat, v.time, v.weekdays, v.date, v.timezone, v.enabled, v.next, v.webSearch, v.gmail],
  );
  res.json({ schedule: toSchedule(rows[0]!) });
});

/** 켜기 / 끄기 */
schedulesRouter.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const userId = req.user!.id;
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  const current = await getOwned(id, userId);
  const next = enabled ? nextRunAt(specOf(current), new Date()) : null;
  if (enabled && !next) throw new HttpError(400, '이미 지난 시각이에요. 수정에서 날짜나 시각을 다시 골라 주세요.');
  const { rows } = await pool.query<ScheduleRow>(
    `update schedules set enabled = $3, next_run_at = $4, updated_at = now()
     where id = $1 and user_id = $2
     returning ${SCHEDULE_COLUMNS}`,
    [id, userId, enabled, next],
  );
  res.json({ schedule: toSchedule(rows[0]!) });
});

schedulesRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const { rowCount } = await pool.query('delete from schedules where id = $1 and user_id = $2', [id, req.user!.id]);
  if (!rowCount) throw new HttpError(404, NOT_FOUND);
  res.status(204).end();
});

/** 지금 바로 한 번 실행 (예약 시각은 그대로). 결과는 끝나면 새 대화로 생긴다 */
schedulesRouter.post('/:id/run', async (req, res) => {
  const id = parseId(req.params.id);
  const schedule = await getOwned(id, req.user!.id);
  if (isRunning(id)) throw new HttpError(409, '이미 실행 중이에요.');
  void runSchedule(schedule);
  res.status(202).json({ schedule: { ...toSchedule(schedule), running: true } });
});
