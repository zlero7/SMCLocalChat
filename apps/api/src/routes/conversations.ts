import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { DEFAULT_TITLE, config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { LlmError, completeChat, isModelLoaded, streamChat, type ToolCall } from '../llm/client.js';
import { getOwnedFiles, toAttachment } from '../files.js';
import { expandAttachments, type HistoryRow } from '../llm/attachments.js';
import { compactionSplit, summarize, type SeqMessage } from '../llm/compact.js';
import {
  buildMessages,
  estimateTokens,
  toModelMessages,
  type ChatMessage,
  type ModelMessage,
  type PromptOptions,
} from '../llm/context.js';
import { slotQueue } from '../llm/queue.js';
import { requireAuth } from '../middleware.js';
import { checkAndStartWindow } from '../quota.js';
import { resolveStyle } from '../styles.js';
import { MAX_RESULT_CHARS, needsApproval, toolSchemas } from '../llm/tools.js';
import { isWebTool, runWebTool, webToolSchemas, type WebSource } from '../llm/webTools.js';
import { webSearchConfigured } from '../web/search.js';
import { DEFAULT_EFFORT, EFFORTS, streamWithEffort } from '../llm/effort.js';
import { gmailToolSchemas, isGmailTool, runGmailTool } from '../llm/gmailTools.js';
import { memoriesForPrompt, rememberFromTurn } from '../llm/memory.js';
import { getOwnedProject } from './projects.js';
import { newShareToken } from './share.js';
import { selectFromDocs } from '../llm/relevant.js';

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

/** 사용자당 진행 중인 생성은 1건. conversationId 로 중단 요청을 연결한다. */
interface ActiveGeneration {
  conversationId: string;
  ctrl: AbortController;
}
const generating = new Map<string, ActiveGeneration>();

const NOT_FOUND = '대화를 찾을 수 없어요';

function parseId(value: string | string[] | undefined): string {
  const parsed = z.string().uuid().safeParse(Array.isArray(value) ? value[0] : value);
  if (!parsed.success) throw new HttpError(404, NOT_FOUND);
  return parsed.data;
}

interface ConversationRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  schedule_id: string | null;
  project_id: string | null;
  unread: boolean;
}

const CONV_COLUMNS = 'id, title, created_at, updated_at, schedule_id, unread, project_id';

/** 남의 대화는 존재하지 않는 것과 똑같이 404 로 응답한다. */
async function getOwned(id: string, userId: string): Promise<ConversationRow> {
  const { rows } = await pool.query<ConversationRow>(
    `select ${CONV_COLUMNS} from conversations where id = $1 and user_id = $2 and deleted_at is null`,
    [id, userId],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return rows[0];
}

const toConversation = (r: ConversationRow) => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  // 예약 작업이 만든 대화인지, 아직 열어 보지 않은 새 결과인지
  scheduled: r.schedule_id !== null,
  projectId: r.project_id,
  unread: r.unread,
});

const titleSchema = z.string().trim().min(1, '제목을 입력해 주세요').max(100, '제목은 100자 이하로 해 주세요');

// ───────────── 목록 / 생성 / 조회 / 이름 변경 / 삭제 ─────────────

conversationsRouter.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  let cursor: Date | null = null;
  if (typeof req.query.cursor === 'string' && req.query.cursor) {
    cursor = new Date(req.query.cursor);
    if (Number.isNaN(cursor.getTime())) throw new HttpError(400, 'cursor 값이 올바르지 않아요');
  }

  const { rows } = await pool.query<ConversationRow>(
    `select ${CONV_COLUMNS} from conversations
     where user_id = $1 and deleted_at is null
       and ($2::timestamptz is null or date_trunc('milliseconds', updated_at) < $2::timestamptz)
     order by updated_at desc
     limit $3`,
    [req.user!.id, cursor, limit + 1],
  );
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? items[items.length - 1]!.updated_at.toISOString() : null;
  res.json({ items: items.map(toConversation), nextCursor });
});

/** 검색어 주변만 잘라 보여 준다 ("…앞 40자 검색어 뒤 60자…") */
function snippetAround(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, 100);
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, at + query.length + 60);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** 대화 검색: 제목이나 메시지 내용에 검색어가 들어간 대화 (최근 순, 30개까지) */
conversationsRouter.get('/search', async (req, res) => {
  const q = z.string().trim().min(1).max(100).safeParse(req.query.q);
  if (!q.success) return void res.json({ items: [] });
  // LIKE 의 특수 문자(% _ \)는 글자 그대로 찾게 한다
  const pattern = `%${q.data.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await pool.query<ConversationRow & { hit: string | null }>(
    `select ${CONV_COLUMNS.split(', ').map((c) => `c.${c}`).join(', ')},
       (select m.content from messages m
         where m.conversation_id = c.id and m.role in ('user', 'assistant') and m.content ilike $2
         order by m.seq desc limit 1) as hit
     from conversations c
     where c.user_id = $1 and c.deleted_at is null
       and (c.title ilike $2 or exists (
         select 1 from messages m where m.conversation_id = c.id and m.role in ('user', 'assistant') and m.content ilike $2))
     order by c.updated_at desc
     limit 30`,
    [req.user!.id, pattern],
  );
  res.json({
    items: rows.map((r) => ({ conversation: toConversation(r), snippet: r.hit ? snippetAround(r.hit, q.data) : null })),
  });
});

conversationsRouter.post('/', async (req, res) => {
  const { title, projectId } = z
    .object({ title: titleSchema.optional(), projectId: z.string().uuid().optional() })
    .parse(req.body ?? {});
  // 프로젝트 안에서 시작하는 대화 (내 프로젝트인지 확인)
  if (projectId) await getOwnedProject(projectId, req.user!.id);
  const { rows } = await pool.query<ConversationRow>(
    `insert into conversations (user_id, title, project_id) values ($1, $2, $3)
     returning ${CONV_COLUMNS}`,
    [req.user!.id, title ?? DEFAULT_TITLE, projectId ?? null],
  );
  res.status(201).json({ conversation: toConversation(rows[0]!) });
});

conversationsRouter.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const conv = await getOwned(id, req.user!.id);
  // 열어 봤으니 새 결과 표시를 끈다
  if (conv.unread) {
    await pool.query('update conversations set unread = false where id = $1', [id]);
    conv.unread = false;
  }
  const [{ rows }, summaryRes] = await Promise.all([
    pool.query(
      `select id, seq, role, content, reasoning, status, model, tools, attachments, created_at from messages
       where conversation_id = $1 and role <> 'system'
       order by seq`,
      [id],
    ),
    pool.query<{ summary_upto_seq: string | null }>('select summary_upto_seq from conversations where id = $1', [id]),
  ]);
  // 요약해서 기억하는 마지막 메시지 (화면에 "여기까지는 요약" 줄을 긋는다)
  const upto = summaryRes.rows[0]?.summary_upto_seq;
  const summarizedThrough = upto ? ([...rows].reverse().find((m) => BigInt(m.seq) <= BigInt(upto))?.id ?? null) : null;
  res.json({
    summarizedThrough,
    conversation: toConversation(conv),
    messages: rows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      status: m.status,
      model: m.model,
      tools: m.tools,
      attachments: m.attachments,
      createdAt: m.created_at,
    })),
    generating: generating.get(req.user!.id)?.conversationId === id,
  });
});

conversationsRouter.patch('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  // 이름 바꾸기, 또는 프로젝트로 옮기기(projectId) / 프로젝트에서 빼기(null)
  const body = z
    .object({ title: titleSchema.optional(), projectId: z.string().uuid().nullable().optional() })
    .refine((v) => v.title !== undefined || v.projectId !== undefined, '바꿀 내용이 없어요')
    .parse(req.body);
  if (body.projectId) await getOwnedProject(body.projectId, req.user!.id);
  const { rows } = await pool.query<ConversationRow>(
    `update conversations set
       title = coalesce($1, title),
       project_id = case when $4 then $5::uuid else project_id end
     where id = $2 and user_id = $3 and deleted_at is null
     returning ${CONV_COLUMNS}`,
    [body.title ?? null, id, req.user!.id, body.projectId !== undefined, body.projectId ?? null],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  res.json({ conversation: toConversation(rows[0]) });
});

conversationsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const userId = req.user!.id;
  const { rowCount } = await pool.query(
    'update conversations set deleted_at = now() where id = $1 and user_id = $2 and deleted_at is null',
    [id, userId],
  );
  if (!rowCount) throw new HttpError(404, NOT_FOUND);
  const active = generating.get(userId);
  if (active?.conversationId === id) active.ctrl.abort();
  res.status(204).end();
});

/** 프로젝트의 지침과, 지금 질문과 관련된 자료 */
async function projectContext(projectId: string, question: string): Promise<PromptOptions['project']> {
  const [project, docs] = await Promise.all([
    pool.query<{ name: string; instructions: string }>('select name, instructions from projects where id = $1', [projectId]),
    pool.query<{ name: string; text: string | null }>(
      `select name, text from files where project_id = $1 and kind = 'document' order by created_at`,
      [projectId],
    ),
  ]);
  if (!project.rows[0]) return null;
  const { text, trimmed } = selectFromDocs(
    docs.rows.map((d) => ({ name: d.name, text: d.text ?? '' })),
    question,
    config.PROJECT_CONTEXT_CHARS,
  );
  return { ...project.rows[0], knowledge: docs.rows.length ? text : '', trimmed };
}

// ───────────── 공유 링크 ─────────────

const shareResponse = (token: string, createdAt: Date) => ({ token, path: `/share/${token}`, createdAt });

conversationsRouter.get('/:id/share', async (req, res) => {
  const id = parseId(req.params.id);
  await getOwned(id, req.user!.id);
  const { rows } = await pool.query<{ token: string; created_at: Date }>(
    'select token, created_at from shares where conversation_id = $1',
    [id],
  );
  res.json({ share: rows[0] ? shareResponse(rows[0].token, rows[0].created_at) : null });
});

/** 공유 링크 만들기. 이미 있으면 같은 링크로 지금까지의 대화를 다시 공유한다 */
conversationsRouter.post('/:id/share', async (req, res) => {
  const id = parseId(req.params.id);
  await getOwned(id, req.user!.id);
  const { rows } = await pool.query<{ token: string; created_at: Date }>(
    `insert into shares (token, conversation_id, user_id, upto_seq)
     values ($1, $2, $3, (select coalesce(max(seq), 0) from messages where conversation_id = $2))
     on conflict (conversation_id) do update set upto_seq = excluded.upto_seq, created_at = now()
     returning token, created_at`,
    [newShareToken(), id, req.user!.id],
  );
  res.json({ share: shareResponse(rows[0]!.token, rows[0]!.created_at) });
});

conversationsRouter.delete('/:id/share', async (req, res) => {
  const id = parseId(req.params.id);
  await getOwned(id, req.user!.id);
  await pool.query('delete from shares where conversation_id = $1', [id]);
  res.status(204).end();
});

// ───────────── 생성 중단 ─────────────

conversationsRouter.post('/:id/stop', async (req, res) => {
  const id = parseId(req.params.id);
  const active = generating.get(req.user!.id);
  if (active && active.conversationId === id) {
    active.ctrl.abort();
    return void res.json({ stopped: true });
  }
  res.json({ stopped: false });
});

// ───────────── 사용자 PC 폴더의 파일 작업 ─────────────
// 파일은 사용자 컴퓨터에 있으므로 서버는 도구 호출을 브라우저에 보내고(tool_exec),
// 브라우저가 사용자가 권한을 준 폴더에서 실행한 결과(tool-result)를 받아 모델에게 돌려준다.

interface ClientToolResult {
  status: 'ok' | 'error' | 'denied';
  result: string;
  summary: string;
  /** 웹 검색이 찾은 출처 (서버가 실행한 웹 도구만) */
  sources?: WebSource[];
}

/** 브라우저의 결과를 기다리는 도구 호출. 키는 "사용자id:호출id" */
const pendingResults = new Map<string, (r: ClientToolResult) => void>();
// 쓰기 작업은 사용자가 허용을 눌러야 하므로 넉넉히 기다린다
const TOOL_TIMEOUT_MS = 10 * 60_000;

function waitToolResult(userId: string, callId: string, signal: AbortSignal): Promise<ClientToolResult> {
  return new Promise((resolve) => {
    const key = `${userId}:${callId}`;
    const finish = (r: ClientToolResult) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pendingResults.delete(key);
      resolve(r);
    };
    const onAbort = () => finish({ status: 'denied', result: '작업이 중단됐습니다.', summary: '중단됨' });
    const timer = setTimeout(
      () => finish({ status: 'denied', result: '사용자가 10분 동안 응답하지 않아 작업을 하지 않았습니다.', summary: '응답 없음' }),
      TOOL_TIMEOUT_MS,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    pendingResults.set(key, finish);
  });
}

conversationsRouter.post('/:id/tool-result', async (req, res) => {
  const id = parseId(req.params.id);
  const userId = req.user!.id;
  const body = z
    .object({
      callId: z.string().min(1).max(200),
      status: z.enum(['ok', 'error', 'denied']),
      result: z.string().max(200_000),
      summary: z.string().max(300),
    })
    .parse(req.body);
  const active = generating.get(userId);
  const finish = active?.conversationId === id ? pendingResults.get(`${userId}:${body.callId}`) : undefined;
  if (!finish) throw new HttpError(404, '결과를 기다리는 작업이 없어요 (이미 끝났거나 시간이 지났어요)');
  finish({ status: body.status, result: body.result, summary: body.summary });
  res.json({ ok: true });
});

/** 화면에 보여줄 도구 인자 (파일 전체 내용 같은 긴 값은 줄인다) */
function displayArgs(args: Record<string, unknown> | null): Record<string, unknown> {
  if (!args) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'content' && typeof v === 'string') out[k] = `(${v.split('\n').length}줄)`;
    else if (typeof v === 'string' && v.length > 300) out[k] = `${v.slice(0, 300)}…`;
    else out[k] = v;
  }
  return out;
}

/** 답변에 도구 이름이 나오면 "쓰겠다고 말만 한" 것으로 본다 */
const TOOL_NAME_RE = /\b(list_dir|find_files|read_file|search_files|write_file|edit_file|make_dir|move_path|copy_path|delete_path|run_command|web_search|fetch_url|gmail_search|gmail_read)\b/g;
/** "읽어보겠습니다", "추가할게요"처럼 할 일을 말하고 끝난 글 (그 뒤에 도구를 안 불렀다면 말만 한 것) */
const PROMISE_END_RE = /(겠습니다|할게요|볼게요|드릴게요|하겠어요|볼까요|할까요|I'll [^.]*|let me [^.]*)[.!…:\s]*$/i;

export interface ToolStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'ok' | 'error' | 'denied';
  summary: string;
  sources?: WebSource[];
}

// ───────────── 메시지 전송 (SSE 스트리밍) ─────────────

const messageLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.MESSAGE_RATE_PER_MIN,
  keyGenerator: (req: Request) => req.user?.id ?? 'anonymous',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '메시지를 너무 빨리 보내고 있어요. 잠시 후 다시 시도해 주세요.' },
});

const sendSchema = z
  .object({
  // 다시 만들기(regenerate)일 때는 비워 둔다 (마지막 질문을 그대로 쓴다)
  content: z
    .string()
    .trim()
    .max(config.MAX_MESSAGE_CHARS, `메시지는 ${config.MAX_MESSAGE_CHARS}자 이하로 해 주세요`)
    .default(''),
  // true: 마지막 답변을 지우고 같은 질문으로 다시 만든다
  regenerate: z.boolean().optional(),
  // 이 사용자 메시지부터 뒤를 지우고 content 로 고쳐서 다시 시작한다
  editMessageId: z.string().uuid().optional(),
  // 먼저 /api/files 로 올려 둔 파일들
  attachmentIds: z.array(z.string().uuid()).max(5, '파일은 한 번에 5개까지 붙일 수 있어요').optional(),
  // 비우면 기본 모델. 목록에 없는 모델은 거절한다
  model: z
    .string()
    .optional()
    .refine((id) => id === undefined || config.MODELS.some((m) => m.id === id), '선택할 수 없는 모델이에요'),
  // 사용자가 브라우저에서 권한을 준 내 컴퓨터 폴더의 이름. 있으면 AI 가 파일 도구를 쓴다
  localFolder: z.string().trim().min(1).max(200).optional(),
  // true 면 AI 가 웹 검색·페이지 읽기 도구를 쓸 수 있다 (서버가 실행)
  webSearch: z.boolean().optional(),
  effort: z.enum(EFFORTS).default(DEFAULT_EFFORT),
  gmail: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.regenerate && !v.content && !v.attachmentIds?.length) ctx.addIssue({ code: 'custom', message: '메시지를 입력해 주세요' });
    if (v.regenerate && v.attachmentIds?.length) ctx.addIssue({ code: 'custom', message: '다시 만들기에는 파일을 붙일 수 없어요' });
    if (v.regenerate && v.editMessageId) ctx.addIssue({ code: 'custom', message: '다시 만들기와 고치기는 함께 할 수 없어요' });
  });

/** 첫 메시지로 만드는 임시 제목 (모델이 더 좋은 제목을 만들면 교체된다) */
function fallbackTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine);
  return chars.length > 30 ? `${chars.slice(0, 30).join('')}…` : oneLine || DEFAULT_TITLE;
}

async function generateTitle(model: string, userText: string, answer: string): Promise<string | null> {
  try {
    const raw = await completeChat({
      model,
      messages: [
        {
          role: 'system',
          content:
            '대화의 제목을 짓는 도우미입니다. 아래 대화를 보고 20자 이내의 짧은 제목 한 줄만 출력하세요. ' +
            '따옴표, 마침표, 설명은 붙이지 마세요. 사용자가 쓴 언어로 쓰세요.',
        },
        { role: 'user', content: `사용자: ${userText.slice(0, 400)}\n\n어시스턴트: ${answer.slice(0, 400)}` },
      ],
      maxTokens: 40,
      // 답변이 끝난 뒤에 따로 오므로 넉넉히 기다린다 (큰 모델은 CPU 를 같이 써서 느리다)
      timeoutMs: 60_000,
    });
    const firstLine = raw.split('\n').find((l) => l.trim()) ?? '';
    const cleaned = firstLine.replace(/^["'“”‘’「」\s]+|["'“”‘’「」.\s]+$/g, '').trim();
    const title = Array.from(cleaned).slice(0, 40).join('');
    if (title.length < 2) console.warn(`[title] 쓸 수 없는 제목 (${model}):`, JSON.stringify(raw.slice(0, 80)));
    return title.length >= 2 ? title : null;
  } catch (err) {
    console.warn(`[title] 제목 생성 실패 (${model}):`, (err as Error).message);
    return null;
  }
}

conversationsRouter.post('/:id/messages', messageLimiter, async (req, res) => {
  const user = req.user!;
  const conversationId = parseId(req.params.id);
  const {
    content: requestText,
    model: requestedModel,
    localFolder,
    webSearch,
    gmail,
    regenerate,
    editMessageId,
    attachmentIds,
    effort,
  } = sendSchema.parse(req.body);
  let userText = requestText;
  if (webSearch && !webSearchConfigured) throw new HttpError(400, '이 사이트에는 웹 검색이 설정되어 있지 않아요.');
  // Gmail 을 켰으면 연결된 계정이 있어야 한다
  const gmailAccount = gmail
    ? (await pool.query<{ email: string }>('select email from google_accounts where user_id = $1', [user.id])).rows[0]
    : undefined;
  if (gmail && !gmailAccount) throw new HttpError(400, 'Gmail 이 연결되어 있지 않아요. 설정에서 먼저 연결해 주세요.');
  const tools = [
    ...(localFolder !== undefined ? toolSchemas : []),
    ...(webSearch ? webToolSchemas : []),
    ...(gmailAccount ? gmailToolSchemas : []),
  ];
  const useTools = tools.length > 0;
  const model = requestedModel ?? config.LLM_MODEL;
  const conv = await getOwned(conversationId, user.id);

  // 확인과 등록 사이에 await 가 없어야 같은 사용자의 동시 요청이 둘 다 통과하지 못한다.
  if (generating.has(user.id)) {
    throw new HttpError(409, '이미 답변을 만들고 있어요. 끝난 뒤에 보내 주세요.');
  }
  const entry: ActiveGeneration = { conversationId: conv.id, ctrl: new AbortController() };
  generating.set(user.id, entry);
  const { ctrl } = entry;

  let sseStarted = false;
  let pingTimer: NodeJS.Timeout | undefined;
  let release: (() => void) | null = null;

  const send = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const clearActive = () => {
    if (generating.get(user.id) === entry) generating.delete(user.id);
  };

  try {
    if (slotQueue.isFull()) {
      throw new HttpError(429, '지금 대기열이 가득 찼어요. 잠시 후 다시 시도해 주세요.');
    }

    const daily = await pool.query<{ n: number }>(
      `select count(*)::int as n from messages m
       join conversations c on c.id = m.conversation_id
       where c.user_id = $1 and m.role = 'user' and m.created_at > now() - interval '1 day'`,
      [user.id],
    );
    if ((daily.rows[0]?.n ?? 0) >= config.DAILY_MESSAGE_LIMIT) {
      throw new HttpError(429, '오늘 보낼 수 있는 메시지를 모두 사용했어요. 내일 다시 이용해 주세요.');
    }
    // 5시간 사용량이 남았는지 확인 (창이 없으면 지금부터 새 5시간이 시작된다)
    await checkAndStartWindow(user.id);

    if (regenerate) {
      // 다시 만들기: 마지막 질문 뒤의 답변을 지우고 그 질문으로 다시 만든다 (질문은 새로 저장하지 않는다)
      const last = await pool.query<{ seq: string; content: string }>(
        `select seq, content from messages where conversation_id = $1 and role = 'user' order by seq desc limit 1`,
        [conv.id],
      );
      if (!last.rows[0]) throw new HttpError(400, '다시 만들 질문이 없어요.');
      await pool.query('delete from messages where conversation_id = $1 and seq > $2', [conv.id, last.rows[0].seq]);
      userText = last.rows[0].content;
    } else if (editMessageId) {
      // 고치기: 그 질문과 그 뒤의 대화를 지우고, 고친 질문으로 새로 시작한다
      const target = await pool.query<{ seq: string }>(
        `select seq from messages where id = $1 and conversation_id = $2 and role = 'user'`,
        [editMessageId, conv.id],
      );
      if (!target.rows[0]) throw new HttpError(404, '고칠 메시지를 찾을 수 없어요.');
      await pool.query('delete from messages where conversation_id = $1 and seq >= $2', [conv.id, target.rows[0].seq]);
      // 요약에 들어 있던 메시지를 고쳤으면 요약도 버린다 (다음에 필요하면 다시 만든다)
      await pool.query(
        'update conversations set summary = null, summary_upto_seq = null where id = $1 and summary_upto_seq >= $2',
        [conv.id, target.rows[0].seq],
      );
    }

    // 사용자 메시지 저장 + 대화 갱신(첫 메시지면 임시 제목)
    const attached = await getOwnedFiles(user.id, attachmentIds ?? []);
    // 파일만 보내면 무엇을 할지 알 수 있게 기본 질문을 넣는다
    if (!userText && attached.length) userText = '첨부한 파일을 살펴봐 주세요.';
    const needsTitle = conv.title === DEFAULT_TITLE;
    const tempTitle = needsTitle ? fallbackTitle(attached.length && requestText === '' ? attached.map((f) => f.name).join(', ') : userText) : conv.title;
    if (!regenerate) {
      await pool.query(`insert into messages (conversation_id, role, content, attachments) values ($1, 'user', $2, $3::jsonb)`, [
        conv.id,
        userText,
        JSON.stringify(attached.map(toAttachment)),
      ]);
      if (attached.length) {
        await pool.query('update files set attached = true where id = any($1::uuid[])', [attached.map((f) => f.id)]);
      }
    }
    await pool.query('update conversations set updated_at = now(), title = $1 where id = $2', [tempTitle, conv.id]);

    // 모델에 보낼 컨텍스트 만들기 (요약해 둔 앞부분은 빼고 그 뒤 메시지만)
    const summaryRes = await pool.query<{ summary: string | null; summary_upto_seq: string | null }>(
      'select summary, summary_upto_seq from conversations where id = $1',
      [conv.id],
    );
    let summary = summaryRes.rows[0]?.summary ?? null;
    const [userRes, historyRes] = await Promise.all([
      pool.query<{ custom_instruction: string; style_id: string }>(
        'select custom_instruction, style_id from users where id = $1',
        [user.id],
      ),
      pool.query<ChatMessage & HistoryRow & { tools: ToolStep[]; seq: string }>(
        `select seq, role, content, tools, attachments from (
           select seq, role, content, tools, attachments from messages
           where conversation_id = $1 and role in ('user', 'assistant') and status <> 'error' and content <> ''
             and seq > $2
           order by seq desc limit 200
         ) t order by seq`,
        [conv.id, summary ? (summaryRes.rows[0]?.summary_upto_seq ?? '0') : '0'],
      ),
    ]);
    const userSettings = userRes.rows[0];
    const style = await resolveStyle(user.id, userSettings?.style_id ?? 'default');

    // 이전 답변에서 한 파일 작업은 짧게 요약해서 붙인다 (모델이 앞에서 무엇을 했는지 알도록)
    const rows = historyRes.rows.map((m) => {
      const tools = Array.isArray(m.tools) ? m.tools : [];
      if (m.role !== 'assistant' || tools.length === 0) return m;
      const done = tools.map((t) => `${t.name}(${String(t.args?.path ?? t.args?.query ?? t.args?.url ?? t.args?.id ?? '')}) → ${t.status}`).join(', ');
      return { ...m, content: `${m.content}\n\n[이 답변을 만들며 쓴 도구: ${done}]` };
    });
    // 첨부 문서의 글자와 최근 이미지를 펼친다
    let history: SeqMessage[] = (await expandAttachments(user.id, rows)).map((m, i) => ({ ...m, seq: rows[i]!.seq }));
    const promptOptions: PromptOptions = {
      customInstruction: userSettings?.custom_instruction ?? '',
      style,
      localFolder: localFolder ?? null,
      webSearch: !!webSearch,
      gmailEmail: gmailAccount?.email ?? null,
      summary,
      project: conv.project_id ? await projectContext(conv.project_id, userText) : null,
      memories: await memoriesForPrompt(user.id),
      effort,
    };

    // ── 여기부터 SSE 응답 ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Nginx 버퍼링 끄기
    });
    res.flushHeaders();
    sseStarted = true;
    res.on('close', () => {
      if (!res.writableEnded) ctrl.abort(); // 브라우저가 닫히면 모델 호출도 끊는다
    });
    pingTimer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    }, 15_000);

    if (needsTitle) send('title', { title: tempTitle });

    let content = '';
    let reasoning = '';
    let status: 'done' | 'stopped' | 'error' = 'done';
    let errorMessage = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let started = false;
    const startedAt = Date.now();
    const steps: ToolStep[] = [];
    // 이 답변에서 메일을 읽었는지 (읽었으면 웹 도구를 막는다)
    let readMail = false;
    const acquireSlot = () => slotQueue.acquire(ctrl.signal, (position) => send('queue', { position }));

    try {
      release = await acquireSlot();
    } catch {
      status = 'stopped'; // 대기 중에 취소됨
    }

    if (release) {
      started = true;
      send('start', {});
      // 모델이 메모리에 없으면 불러오는 데 몇 분 걸릴 수 있으니 화면에 알린다 (확인은 호출 전에 해야 정확하다)
      if ((await isModelLoaded(model)) === false) send('loading', { model });
      // 대화가 너무 길면 앞부분을 요약한다 (실패하면 요약 없이 오래된 메시지를 잘라 보낸다)
      const split = compactionSplit(promptOptions, history);
      if (split > 0) {
        send('compacting', {});
        try {
          summary = await summarize(model, summary, history.slice(0, split));
          const upto = history[split - 1]!.seq;
          await pool.query('update conversations set summary = $1, summary_upto_seq = $2 where id = $3', [summary, upto, conv.id]);
          history = history.slice(split);
          promptOptions.summary = summary;
          console.log(`[chat] 긴 대화 앞부분 메시지 ${split}개를 요약함 (${summary.length}자)`);
        } catch (err) {
          console.warn('[chat] 대화 요약 실패, 오래된 메시지를 잘라서 보냄:', (err as Error).message);
        }
      }
      const msgs: ModelMessage[] = toModelMessages(buildMessages(promptOptions, history));
      // Qwen 3.5 는 도구 결과를 받은 뒤 생각 모드로 부르면 생각만 하고 멈추는 일이 잦다 (실험: 5번 중 4번).
      // 그래서 생각은 첫 라운드(계획 세우기)에만 켜고, 도구 결과를 받은 뒤의 라운드는 끈다.
      let thinkThisRound = config.LLM_ENABLE_THINKING;
      let retried = false;
      let nudges = 0;
      try {
        // 도구를 부르면 결과를 돌려주고 다시 부른다 (도구 호출이 없으면 한 번으로 끝)
        for (let round = 0; ; round++) {
          let roundText = '';
          let calls: ToolCall[] = [];
          for await (const ev of streamWithEffort({
            model,
            messages: msgs,
            signal: ctrl.signal,
            enableThinking: thinkThisRound,
            effort,
            tools: useTools ? tools : undefined,
          })) {
            if (ev.type === 'reasoning') {
              reasoning += ev.text;
              send('reasoning', { text: ev.text });
            } else if (ev.type === 'delta') {
              content += ev.text;
              roundText += ev.text;
              send('delta', { text: ev.text });
            } else if (ev.type === 'usage') {
              promptTokens += ev.promptTokens;
              completionTokens += ev.completionTokens;
            } else {
              calls = ev.calls;
            }
          }
          // 작업 폴더 대화에서 글도 도구 호출도 없이 끝나면(생각만 하고 멈춤) 생각을 끄고 한 번 더 시도한다
          if (useTools && calls.length === 0 && !roundText.trim() && !retried) {
            retried = true;
            thinkThisRound = false;
            console.warn(`[chat] 생각만 하고 멈춰서 생각 없이 다시 시도 (${model})`);
            continue;
          }
          // 작은 모델은 "edit_file 로 추가하겠습니다"라고 말만 하고 끝내기도 한다 → 실제로 부르라고 두 번까지 재촉한다
          // (이미 실행한 도구를 "edit_file 로 고쳤어요"처럼 정리하는 경우는 재촉하지 않는다)
          const promised = [...roundText.matchAll(TOOL_NAME_RE)].map((m) => m[1]);
          const unrun = promised.filter((name) => !steps.some((s) => s.name === name && s.status === 'ok'));
          const promisedAction = unrun.length > 0 || PROMISE_END_RE.test(roundText.trim());
          if (useTools && calls.length === 0 && nudges < 2 && promisedAction) {
            nudges++;
            thinkThisRound = false;
            msgs.push({ role: 'assistant', content: roundText });
            msgs.push({
              role: 'user',
              content: '말로 설명만 하지 말고, 방금 말한 작업을 지금 바로 도구를 호출해서 실제로 진행해 주세요.',
            });
            console.warn(`[chat] 도구를 쓰겠다고만 하고 멈춰서 재촉 (${nudges}번째, ${model})`);
            continue;
          }
          if (!useTools || calls.length === 0) break;
          thinkThisRound = false;
          if (round >= config.AGENT_MAX_STEPS) {
            const note = '\n\n(도구를 너무 많이 써서 여기서 멈췄어요. 이어서 하려면 "계속해 줘"라고 보내 주세요.)';
            content += note;
            send('delta', { text: note });
            break;
          }

          msgs.push({
            role: 'assistant',
            content: roundText,
            tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
          });
          for (const call of calls) {
            let args: Record<string, any> | null = null;
            try {
              const parsed = JSON.parse(call.arguments || '{}');
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
            } catch {
              /* 아래에서 오류로 돌려준다 */
            }
            const shown = displayArgs(args);
            let outcome: ClientToolResult;
            if (!args) {
              outcome = { status: 'error', result: '오류: 도구 인자가 올바른 JSON 이 아니에요', summary: '잘못된 인자' };
            } else if (isGmailTool(call.name)) {
              if (!gmailAccount) {
                outcome = { status: 'error', result: '오류: 이 대화에서는 Gmail 을 쓸 수 없어요', summary: 'Gmail 꺼짐' };
              } else {
                send('tool_start', { id: call.id, name: call.name, args: shown });
                outcome = await runGmailTool(user.id, call.name, args, ctrl.signal);
                readMail = true;
              }
            } else if (isWebTool(call.name)) {
              if (!webSearch) {
                outcome = { status: 'error', result: '오류: 이 대화에서는 웹 검색을 쓸 수 없어요', summary: '웹 검색 꺼짐' };
              } else if (readMail) {
                // 메일을 읽은 뒤에는 같은 답변 안에서 바깥으로 요청을 보내지 않는다
                // (메일 속 글이 AI 를 속여 메일 내용을 검색어나 주소에 실어 빼돌리지 못하게)
                outcome = {
                  status: 'error',
                  result: '보안 규칙: 이 답변에서 메일을 읽었기 때문에 웹 검색·페이지 읽기를 할 수 없습니다. 웹 정보 없이 답하세요.',
                  summary: '메일을 읽어서 웹 사용 막음',
                };
              } else {
                // 웹 도구는 서버가 직접 실행한다. 화면에는 진행 중인 단계로 먼저 보여 준다
                send('tool_start', { id: call.id, name: call.name, args: shown });
                outcome = await runWebTool(call.name, args, ctrl.signal);
              }
            } else if (readMail && call.name === 'run_command') {
              // 메일 속 글이 AI 를 속여 명령을 실행하게 하지 못하도록 (파일 읽기·쓰기는 그대로 둔다)
              outcome = {
                status: 'error',
                result: '보안 규칙: 이 답변에서 메일을 읽었기 때문에 명령을 실행할 수 없습니다. 명령 없이 답하세요.',
                summary: '메일을 읽어서 명령 실행 막음',
              };
            } else if (localFolder === undefined) {
              outcome = { status: 'error', result: '오류: 이 대화에는 작업 폴더가 없어서 파일 도구를 쓸 수 없어요', summary: '작업 폴더 없음' };
            } else {
              // 브라우저가 사용자 PC 폴더에서 실행한다 (쓰기 작업은 브라우저가 사용자에게 허용을 묻는다)
              const approval = needsApproval(call.name);
              send('tool_exec', { id: call.id, name: call.name, args, needsApproval: approval });
              if (approval) {
                // 사용자를 기다리는 동안 모델 자리를 다른 사람에게 내준다
                release?.();
                release = null;
              }
              outcome = await waitToolResult(user.id, call.id, ctrl.signal);
              if (ctrl.signal.aborted) throw new Error('aborted');
              if (!release) {
                release = await acquireSlot();
                send('start', {});
              }
              if (outcome.result.length > MAX_RESULT_CHARS) {
                const cut = outcome.result.length - MAX_RESULT_CHARS;
                outcome = { ...outcome, result: `${outcome.result.slice(0, MAX_RESULT_CHARS)}\n…(너무 길어서 ${cut}자를 생략함)` };
              }
            }
            const step: ToolStep = {
              id: call.id,
              name: call.name,
              args: shown,
              status: outcome.status,
              summary: outcome.summary,
              ...(outcome.sources?.length ? { sources: outcome.sources } : {}),
            };
            steps.push(step);
            send('tool_result', step);
            msgs.push({ role: 'tool', tool_call_id: call.id, content: outcome.result });
          }
          // 다음 라운드의 글이 앞 글에 바로 붙지 않게
          if (content.trim() && !content.endsWith('\n\n')) {
            const gap = content.endsWith('\n') ? '\n' : '\n\n';
            content += gap;
            send('delta', { text: gap });
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) {
          status = 'stopped';
        } else {
          status = 'error';
          errorMessage = err instanceof LlmError ? err.message : '답변을 만드는 중 문제가 생겼어요.';
          console.error('[chat] 생성 실패:', (err as Error).message);
        }
      }
      release?.();
      release = null;
    }
    content = content.trimEnd();
    // 작은 모델은 가끔 답까지 생각 안에 쓰고 생각을 닫지 않은 채 끝낸다 → 답이 빈 칸으로 보이므로 생각을 답으로 옮긴다
    if (status === 'done' && !content.trim() && reasoning.trim()) {
      const prefix = config.LLM_THINKING_PREFIX.trim();
      content = (prefix && reasoning.trimStart().startsWith(prefix) ? reasoning.trimStart().slice(prefix.length) : reasoning).trim();
      reasoning = '';
      console.warn(`[chat] 생각만 있고 답이 없어 생각을 답으로 옮김 (${model})`);
    }
    clearActive(); // 제목 생성을 기다리는 동안 다음 메시지를 보낼 수 있게 먼저 풀어준다

    // 결과 저장 (중단돼도 받은 데까지는 남긴다)
    const durationMs = Date.now() - startedAt;
    if (completionTokens === 0) completionTokens = estimateTokens(content + reasoning);
    let messageId: string | null = null;
    try {
      if (status === 'error' || content || reasoning || steps.length) {
        const inserted = await pool.query<{ id: string }>(
          `insert into messages (conversation_id, role, content, reasoning, status, model, token_count, tools)
           values ($1, 'assistant', $2, $3, $4, $5, $6, $7::jsonb) returning id`,
          [conv.id, content, reasoning, status, model, completionTokens, JSON.stringify(steps)],
        );
        messageId = inserted.rows[0]!.id;
      }
      await pool.query('update conversations set updated_at = now() where id = $1', [conv.id]);
      if (started) {
        await pool.query(
          'insert into usage_logs (user_id, prompt_tokens, completion_tokens, duration_ms) values ($1, $2, $3, $4)',
          [user.id, promptTokens, completionTokens, durationMs],
        );
      }
    } catch (err) {
      console.error('[chat] 결과 저장 실패:', (err as Error).message);
    }

    if (status === 'error') send('error', { message: errorMessage });
    send('done', { messageId, status, completionTokens, durationMs });

    // 답변이 끝난 뒤의 일 (done 이후에 도착해도 클라이언트가 처리한다)
    // - 모델이 더 나은 제목을 만들면 교체
    // - 이번 대화에서 사용자에 대해 새로 알게 된 것을 기억 (다시 만들기는 같은 질문이라 건너뛴다)
    const titleJob =
      needsTitle && status === 'done' && content
        ? generateTitle(model, userText, content).then(async (better) => {
            if (!better) return;
            await pool.query('update conversations set title = $1 where id = $2 and user_id = $3', [better, conv.id, user.id]);
            send('title', { title: better });
          })
        : Promise.resolve();
    const memoryJob =
      status === 'done' && content && !regenerate
        ? rememberFromTurn({ userId: user.id, conversationId: conv.id, model, userText, answer: content })
            .then((items) => {
              if (items.length) send('memory', { items });
            })
            .catch((err) => console.warn('[memory] 기억하기 실패:', (err as Error).message))
        : Promise.resolve();
    await Promise.all([titleJob, memoryJob]);
  } catch (err) {
    if (!sseStarted) throw err;
    console.error('[chat] 처리 중 오류:', (err as Error).message);
    send('error', { message: '답변을 만드는 중 문제가 생겼어요.' });
    send('done', { messageId: null, status: 'error', completionTokens: 0, durationMs: 0 });
  } finally {
    if (pingTimer) clearInterval(pingTimer);
    release?.();
    clearActive();
    if (sseStarted && !res.writableEnded) res.end();
  }
});
