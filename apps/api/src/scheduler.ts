import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';
import { LlmError, streamChat, type ToolCall } from './llm/client.js';
import { buildMessages, estimateTokens, type ModelMessage } from './llm/context.js';
import { slotQueue } from './llm/queue.js';
import { MAX_RESULT_CHARS } from './llm/tools.js';
import { gmailToolSchemas, isGmailTool, runGmailTool } from './llm/gmailTools.js';
import { isWebTool, runWebTool, webToolSchemas, type WebSource, type WebToolOutcome } from './llm/webTools.js';
import { checkAndStartWindow } from './quota.js';
import { nextRunAt, type Repeat, type ScheduleSpec } from './scheduleTime.js';
import { resolveStyle } from './styles.js';
import { DEFAULT_EFFORT, streamWithEffort } from './llm/effort.js';
import { memoriesForPrompt } from './llm/memory.js';
import { webSearchConfigured } from './web/search.js';

/** 사용자 한 명이 만들 수 있는 예약 작업 수 (관리자가 바꾸지 않았을 때) */
export const DEFAULT_MAX_SCHEDULES = 10;
const MAX_SCHEDULES_KEY = 'max_schedules_per_user';
/** 예약 작업이 동시에 차지할 수 있는 모델 칸 수 (나머지는 사람들이 바로 쓰도록 남긴다) */
const MAX_BACKGROUND = 2;
/** 한 번 실행에 기다리는 최대 시간 (대기열 + 생성) */
const RUN_TIMEOUT_MS = 15 * 60_000;
const TICK_MS = 30_000;
/** 웹 검색을 쓰는 예약 작업이 검색·읽기를 되풀이할 수 있는 최대 횟수 */
const MAX_WEB_ROUNDS = 8;

export async function getMaxSchedules(): Promise<number> {
  const { rows } = await pool.query<{ value: unknown }>('select value from app_settings where key = $1', [MAX_SCHEDULES_KEY]);
  const v = rows[0]?.value;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : DEFAULT_MAX_SCHEDULES;
}

export async function setMaxSchedules(n: number): Promise<void> {
  await pool.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [MAX_SCHEDULES_KEY, JSON.stringify(n)],
  );
}

export interface ScheduleRow {
  id: string;
  user_id: string;
  title: string;
  prompt: string;
  model: string | null;
  style_id: string | null;
  repeat: Repeat;
  time_of_day: string;
  weekdays: number[];
  run_date: string | null;
  timezone: string;
  enabled: boolean;
  web_search: boolean;
  gmail: boolean;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_status: 'done' | 'error' | 'skipped' | null;
  last_message: string | null;
  last_conversation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

// run_date 는 날짜 그대로 받도록 문자열로 꺼낸다 (Date 로 바뀌면 시간대 때문에 하루 밀릴 수 있다)
export const SCHEDULE_COLUMNS = `id, user_id, title, prompt, model, style_id, repeat, time_of_day, weekdays,
  to_char(run_date, 'YYYY-MM-DD') as run_date, timezone, enabled, web_search, gmail, next_run_at, last_run_at, last_status,
  last_message, last_conversation_id, created_at, updated_at`;

export const specOf = (r: Pick<ScheduleRow, 'repeat' | 'time_of_day' | 'weekdays' | 'run_date' | 'timezone'>): ScheduleSpec => ({
  repeat: r.repeat,
  time: r.time_of_day,
  weekdays: r.weekdays,
  date: r.run_date,
  timezone: r.timezone,
});

/** 지금 실행 중인 예약 작업 id */
const running = new Set<string>();
export const isRunning = (id: string) => running.has(id);

async function finish(id: string, status: 'done' | 'error' | 'skipped', message: string | null, conversationId: string | null) {
  await pool.query(
    `update schedules set last_run_at = now(), last_status = $2, last_message = $3,
       last_conversation_id = coalesce($4, last_conversation_id)
     where id = $1`,
    [id, status, message, conversationId],
  );
}

/**
 * 예약 작업 한 번 실행: 지시를 AI 에게 보내고 결과를 새 대화로 저장한다.
 * 이미 실행 중이면 false (아무것도 하지 않음).
 */
export async function runSchedule(s: ScheduleRow): Promise<boolean> {
  if (running.has(s.id)) return false;
  running.add(s.id);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
  try {
    // 5시간 사용량이 남았는지 (다 썼으면 건너뛰고 이유를 남긴다)
    try {
      await checkAndStartWindow(s.user_id);
    } catch (err) {
      if (err instanceof HttpError) {
        await finish(s.id, 'skipped', err.message, null);
        console.log(`[schedule] 건너뜀 "${s.title}": ${err.message}`);
        return true;
      }
      throw err;
    }

    const model = s.model && config.MODELS.some((m) => m.id === s.model) ? s.model : config.LLM_MODEL;
    const { rows } = await pool.query<{ custom_instruction: string; style_id: string }>(
      'select custom_instruction, style_id from users where id = $1',
      [s.user_id],
    );
    const user = rows[0];
    if (!user) return true; // 그 사이 계정이 지워짐
    const style = await resolveStyle(s.user_id, s.style_id ?? user.style_id);
    // 웹 검색을 켠 작업이라도 사이트에서 검색이 꺼져 있으면 검색 없이 실행한다
    const useWeb = s.web_search && webSearchConfigured;
    // Gmail 을 켠 작업이면 연결된 계정이 있을 때만 (없으면 Gmail 없이 실행)
    const gmailAccount = s.gmail
      ? (await pool.query<{ email: string }>('select email from google_accounts where user_id = $1', [s.user_id])).rows[0]
      : undefined;
    const runTools = [...(useWeb ? webToolSchemas : []), ...(gmailAccount ? gmailToolSchemas : [])];
    const useTools = runTools.length > 0;
    let readMail = false;
    const msgs: ModelMessage[] = buildMessages(
      {
        customInstruction: user.custom_instruction,
        style,
        webSearch: useWeb,
        gmailEmail: gmailAccount?.email ?? null,
        scheduledTitle: s.title,
        memories: await memoriesForPrompt(s.user_id),
      },
      [{ role: 'user', content: s.prompt }],
    );

    let content = '';
    let reasoning = '';
    let status: 'done' | 'error' = 'done';
    let errorMessage = '';
    let promptTokens = 0;
    let completionTokens = 0;
    const steps: {
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: 'ok' | 'error';
      summary: string;
      sources?: WebSource[];
    }[] = [];
    const startedAt = Date.now();
    let release: (() => void) | null = null;
    try {
      release = await slotQueue.acquire(ctrl.signal, () => {});
      // 일반 대화처럼 생각은 첫 라운드에만 켜고, 검색 결과를 받은 뒤에는 끈다
      let think = config.LLM_ENABLE_THINKING;
      let retried = false;
      for (let round = 0; ; round++) {
        let roundText = '';
        let calls: ToolCall[] = [];
        for await (const ev of streamWithEffort({
          model,
          messages: msgs,
          signal: ctrl.signal,
          enableThinking: think,
          effort: DEFAULT_EFFORT,
          tools: useTools ? runTools : undefined,
        })) {
          if (ev.type === 'reasoning') reasoning += ev.text;
          else if (ev.type === 'delta') {
            content += ev.text;
            roundText += ev.text;
          } else if (ev.type === 'usage') {
            promptTokens += ev.promptTokens;
            completionTokens += ev.completionTokens;
          } else calls = ev.calls;
        }
        // 생각만 하고 아무것도 안 하고 멈추면 생각 없이 한 번 더
        if (useTools && calls.length === 0 && !roundText.trim() && !retried) {
          retried = true;
          think = false;
          continue;
        }
        if (!useTools || calls.length === 0 || round >= MAX_WEB_ROUNDS) break;
        think = false;
        msgs.push({
          role: 'assistant',
          content: roundText,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });
        for (const call of calls) {
          let args: Record<string, unknown> | null = null;
          try {
            const parsed = JSON.parse(call.arguments || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
          } catch {
            /* 아래에서 오류로 돌려준다 */
          }
          let outcome: WebToolOutcome;
          if (!args) {
            outcome = { status: 'error', result: '오류: 도구 인자가 올바른 JSON 이 아니에요', summary: '잘못된 인자' };
          } else if (gmailAccount && isGmailTool(call.name)) {
            outcome = await runGmailTool(s.user_id, call.name, args, ctrl.signal);
            readMail = true;
          } else if (useWeb && isWebTool(call.name)) {
            // 메일을 읽은 뒤에는 바깥으로 요청을 보내지 않는다 (대화와 같은 보안 규칙)
            outcome = readMail
              ? { status: 'error', result: '보안 규칙: 메일을 읽었기 때문에 웹 검색·페이지 읽기를 할 수 없습니다.', summary: '메일을 읽어서 웹 사용 막음' }
              : await runWebTool(call.name, args, ctrl.signal);
          } else {
            outcome = { status: 'error', result: `오류: 이 예약 작업에서는 쓸 수 없는 도구예요 (${call.name})`, summary: '쓸 수 없는 도구' };
          }
          steps.push({
            id: call.id,
            name: call.name,
            args: args ?? {},
            status: outcome.status,
            summary: outcome.summary,
            ...('sources' in outcome && outcome.sources?.length ? { sources: outcome.sources } : {}),
          });
          msgs.push({ role: 'tool', tool_call_id: call.id, content: outcome.result.slice(0, MAX_RESULT_CHARS) });
        }
        if (content.trim() && !content.endsWith('\n\n')) content += content.endsWith('\n') ? '\n' : '\n\n';
      }
    } catch (err) {
      status = 'error';
      errorMessage = ctrl.signal.aborted
        ? '시간이 너무 오래 걸려서 멈췄어요.'
        : err instanceof LlmError
          ? err.message
          : '답변을 만드는 중 문제가 생겼어요.';
      console.error(`[schedule] 실행 실패 "${s.title}":`, (err as Error).message);
    } finally {
      release?.();
    }
    content = content.trim();
    // 생각만 있고 답이 비면 생각을 답으로 옮긴다 (일반 대화와 같은 처리)
    if (status === 'done' && !content && reasoning.trim()) {
      const prefix = config.LLM_THINKING_PREFIX.trim();
      const r = reasoning.trimStart();
      content = (prefix && r.startsWith(prefix) ? r.slice(prefix.length) : r).trim();
      reasoning = '';
    }
    if (completionTokens === 0) completionTokens = estimateTokens(content + reasoning);

    // 결과를 새 대화로 저장 (실패해도 무엇이 잘못됐는지 대화에 남긴다)
    const client = await pool.connect();
    let conversationId: string | null = null;
    try {
      await client.query('begin');
      const conv = await client.query<{ id: string }>(
        `insert into conversations (user_id, title, schedule_id, unread) values ($1, $2, $3, true) returning id`,
        [s.user_id, s.title, s.id],
      );
      conversationId = conv.rows[0]!.id;
      await client.query(`insert into messages (conversation_id, role, content) values ($1, 'user', $2)`, [conversationId, s.prompt]);
      await client.query(
        `insert into messages (conversation_id, role, content, reasoning, status, model, token_count, tools)
         values ($1, 'assistant', $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          conversationId,
          status === 'error' ? `(예약 실행 실패: ${errorMessage})` : content,
          reasoning,
          status,
          model,
          completionTokens,
          JSON.stringify(steps),
        ],
      );
      await client.query(
        'insert into usage_logs (user_id, prompt_tokens, completion_tokens, duration_ms) values ($1, $2, $3, $4)',
        [s.user_id, promptTokens, completionTokens, Date.now() - startedAt],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await finish(s.id, status, status === 'error' ? errorMessage : null, conversationId);
    console.log(`[schedule] 실행 ${status === 'done' ? '완료' : '실패'} "${s.title}" (${((Date.now() - startedAt) / 1000).toFixed(0)}초)`);
    return true;
  } catch (err) {
    console.error(`[schedule] 처리 중 오류 "${s.title}":`, (err as Error).message);
    await finish(s.id, 'error', '실행 중 문제가 생겼어요.', null).catch(() => {});
    return true;
  } finally {
    clearTimeout(timer);
    running.delete(s.id);
  }
}

/** 실행할 때가 된 예약 작업을 찾아 다음 실행 시각을 먼저 옮겨 두고 실행한다 */
async function tick() {
  const free = MAX_BACKGROUND - running.size;
  if (free <= 0) return;
  const { rows } = await pool.query<ScheduleRow>(
    `select ${SCHEDULE_COLUMNS} from schedules
     where enabled and next_run_at <= now()
     order by next_run_at limit $1`,
    [free],
  );
  for (const s of rows) {
    if (running.has(s.id)) continue;
    // 서버가 꺼져 있어 놓친 실행은 한 번만 하고, 다음 시각은 지금 기준으로 다시 잡는다
    const next = nextRunAt(specOf(s), new Date());
    const claimed = await pool.query(
      `update schedules set next_run_at = $2, enabled = $3
       where id = $1 and next_run_at = $4`,
      [s.id, next, next !== null, s.next_run_at],
    );
    if (!claimed.rowCount) continue; // 그 사이 사용자가 고쳤다
    void runSchedule(s);
  }
}

let started = false;

export function startScheduler() {
  if (started) return;
  started = true;
  const loop = () =>
    tick().catch((err) => console.error('[schedule] 확인 실패:', (err as Error).message));
  void loop();
  setInterval(loop, TICK_MS).unref();
  console.log('[schedule] 예약 작업 확인 시작 (30초마다)');
}
