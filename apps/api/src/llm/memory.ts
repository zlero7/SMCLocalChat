/**
 * 기억: 대화에서 사용자에 대한 오래 가는 사실을 뽑아 저장하고, 모든 대화에 넣어 준다 (Claude 의 메모리처럼).
 * 민감한 정보는 뽑지 않고, 사용자는 설정에서 보고 지우거나 기능을 끌 수 있다.
 */
import { pool } from '../db.js';
import { completeChat } from './client.js';

/** 한 사람이 가질 수 있는 기억 수 (넘으면 새로 기억하지 않는다) */
export const MAX_MEMORIES = 100;
/** 시스템 프롬프트에 넣는 기억의 최대 글자 수 (최근 것부터) */
const PROMPT_CHARS = 2000;
const MAX_MEMORY_CHARS = 200;

export interface MemoryRow {
  id: string;
  content: string;
  source_conversation_id: string | null;
  created_at: Date;
}

export const toMemory = (m: MemoryRow) => ({
  id: m.id,
  content: m.content,
  conversationId: m.source_conversation_id,
  createdAt: m.created_at,
});

export async function listMemories(userId: string): Promise<MemoryRow[]> {
  const { rows } = await pool.query<MemoryRow>(
    'select id, content, source_conversation_id, created_at from memories where user_id = $1 order by created_at desc',
    [userId],
  );
  return rows;
}

/** 기억 기능을 켰으면 시스템 프롬프트에 넣을 기억 목록 (최근 것부터 PROMPT_CHARS 까지) */
export async function memoriesForPrompt(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ memory_enabled: boolean }>('select memory_enabled from users where id = $1', [userId]);
  if (!rows[0]?.memory_enabled) return [];
  const out: string[] = [];
  let used = 0;
  for (const m of await listMemories(userId)) {
    if (used + m.content.length > PROMPT_CHARS) break;
    out.push(m.content);
    used += m.content.length;
  }
  return out;
}

const normalize = (s: string) => s.replace(/[\s.,!?·"'“”]/g, '').toLowerCase();

/** 이미 있는 기억과 거의 같은지 (한쪽이 다른 쪽을 포함하면 같은 것으로 본다) */
function isDuplicate(candidate: string, existing: string[]): boolean {
  const c = normalize(candidate);
  return existing.some((e) => {
    const n = normalize(e);
    return n === c || (c.length > 6 && n.includes(c)) || (n.length > 6 && c.includes(n));
  });
}

// 혹시 모델이 뽑더라도 저장하지 않을 민감한 내용
const SENSITIVE = /(비밀\s?번호|패스워드|password|비번|계좌|카드\s?번호|주민\s?(등록)?\s?번호|여권\s?번호|\b\d{6}-?\d{7}\b|\b(?:\d[ -]?){13,16}\b|api\s?key|토큰)/i;

/** 모델 출력에서 JSON 문자열 배열만 꺼낸다 */
function parseList(raw: string): string[] {
  const match = /\[[\s\S]*\]/.exec(raw);
  if (!match) return [];
  try {
    const list = JSON.parse(match[0]);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 방금 주고받은 대화에서 새로 기억할 것을 뽑아 저장하고, 저장한 것을 돌려준다.
 * 기억 기능이 꺼져 있거나 뽑을 게 없으면 빈 배열.
 */
export async function rememberFromTurn(opts: {
  userId: string;
  conversationId: string;
  model: string;
  userText: string;
  answer: string;
}): Promise<{ id: string; content: string }[]> {
  const { rows } = await pool.query<{ memory_enabled: boolean }>('select memory_enabled from users where id = $1', [
    opts.userId,
  ]);
  if (!rows[0]?.memory_enabled) return [];
  // 너무 짧은 메시지("응", "고마워")에서는 뽑을 게 없다
  if (opts.userText.replace(/\s/g, '').length < 6) return [];
  const existing = (await listMemories(opts.userId)).map((m) => m.content);
  if (existing.length >= MAX_MEMORIES) return [];

  const raw = await completeChat({
    model: opts.model,
    messages: [
      {
        role: 'system',
        content:
          '당신은 사용자에 대한 장기 기억을 관리합니다. 아래 대화에서, 앞으로 다른 대화에서도 쓸모 있을 "사용자 자신에 대한 오래 가는 사실"만 뽑으세요. ' +
          '예: 이름·호칭, 직업·학교·전공·학년, 사는 지역, 관심사·취미, 좋아하는 답변 방식, 오래 하는 일이나 프로젝트, 사용자가 "기억해"라고 부탁한 것. ' +
          '뽑지 말 것: 이번 질문 하나에만 해당하는 내용, 일반 지식, AI 답변의 내용, 이미 기억한 것과 같은 내용, ' +
          '그리고 민감한 정보(비밀번호, 계좌·카드·주민번호 같은 번호, 건강·병력, 정치·종교 성향, 성생활). ' +
          '각 항목은 "사용자는 …" 처럼 한 문장으로 짧게 쓰세요. 결과는 JSON 문자열 배열 하나로만 출력하고, 없으면 [] 만 출력하세요.',
      },
      {
        role: 'user',
        content:
          (existing.length ? `[이미 기억한 것]\n${existing.slice(0, 40).map((e) => `- ${e}`).join('\n')}\n\n` : '') +
          `[사용자 메시지]\n${opts.userText.slice(0, 2000)}\n\n[AI 답변 앞부분]\n${opts.answer.slice(0, 600)}`,
      },
    ],
    maxTokens: 300,
    timeoutMs: 60_000,
  });

  const saved: { id: string; content: string }[] = [];
  const known = [...existing];
  for (const item of parseList(raw).slice(0, 3)) {
    const content = item.replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_CHARS);
    if (content.length < 4 || SENSITIVE.test(content) || isDuplicate(content, known)) continue;
    const { rows: ins } = await pool.query<{ id: string }>(
      'insert into memories (user_id, content, source_conversation_id) values ($1, $2, $3) returning id',
      [opts.userId, content, opts.conversationId],
    );
    saved.push({ id: ins[0]!.id, content });
    known.push(content);
  }
  return saved;
}

/** 사용자가 직접 적은 기억 저장 */
export async function addMemory(userId: string, content: string): Promise<MemoryRow> {
  const { rows } = await pool.query<MemoryRow>(
    `insert into memories (user_id, content) values ($1, $2)
     returning id, content, source_conversation_id, created_at`,
    [userId, content.trim().slice(0, MAX_MEMORY_CHARS)],
  );
  return rows[0]!;
}
