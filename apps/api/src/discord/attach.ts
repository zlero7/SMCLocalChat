/**
 * 디스코드 봇의 파일 처리 (디스코드 라이브러리와 무관해서 따로 시험할 수 있다):
 *  - 사용자가 올린 첨부(이미지·PDF·워드·텍스트·코드)를 내려받아 모델이 읽을 수 있게 바꾼다 (서버에 저장하지 않는다)
 *  - 모델이 파일을 만들어 올릴 때 쓰는 도구(send_file)와 파일 이름 검사
 *  - 모델 입력 길이(컨텍스트)에 맞게 문서와 지난 대화를 줄이기
 */
import { config } from '../config.js';
import { inspectUpload } from '../files.js';
import { IMAGE_TOKENS, estimateTokens, type ContentPart } from '../llm/context.js';
import { selectRelevant } from '../llm/relevant.js';
import type { Turn } from './core.js';

// ───────── 첨부 내려받기 ─────────

/** 디스코드 첨부 파일이 있는 곳. 여기 말고는 내려받지 않는다 (서버가 엉뚱한 주소를 열게 속이는 것을 막는다) */
export const DISCORD_FILE_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];
export const MAX_ATTACHMENTS = 4;
const MAX_IMAGES = 3;
const DOWNLOAD_TIMEOUT_MS = 20_000;

export function isDiscordCdn(url: string, hosts: string[] = DISCORD_FILE_HOSTS): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.includes(u.hostname);
  } catch {
    return false;
  }
}

export interface IncomingFile {
  name: string;
  url: string;
  size: number;
}

/** 크기 제한을 지키며 내려받는다 (제한을 넘으면 읽다가 멈춘다) */
export async function downloadFile(url: string, maxBytes: number, opts: { hosts?: string[]; allowInsecure?: boolean } = {}): Promise<Buffer> {
  if (!opts.allowInsecure && !isDiscordCdn(url, opts.hosts)) throw new Error('디스코드 첨부 주소가 아니에요');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`내려받지 못했어요 (${res.status})`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('파일이 너무 커요');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('파일이 너무 커요');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export interface Prepared {
  /** 모델에게 보여 줄 이미지 (data: 주소) */
  images: string[];
  docs: { name: string; text: string }[];
  /** 읽지 못한 파일 등 모델과 사용자에게 알려야 할 말 */
  notes: string[];
  names: string[];
}

/** 첨부를 모두 내려받아 이미지와 문서 글자로 나눈다. 읽지 못한 것은 notes 에 이유를 적는다 */
export async function prepareAttachments(files: IncomingFile[], opts: { hosts?: string[]; allowInsecure?: boolean } = {}): Promise<Prepared> {
  const out: Prepared = { images: [], docs: [], notes: [], names: [] };
  const maxBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
  if (files.length > MAX_ATTACHMENTS) out.notes.push(`첨부가 ${files.length}개라서 앞의 ${MAX_ATTACHMENTS}개만 읽었어요`);
  for (const f of files.slice(0, MAX_ATTACHMENTS)) {
    out.names.push(f.name);
    if (f.size > maxBytes) {
      out.notes.push(`${f.name}: 파일이 너무 커서 읽지 못했어요 (최대 ${config.MAX_UPLOAD_MB}MB)`);
      continue;
    }
    try {
      const data = await downloadFile(f.url, maxBytes, opts);
      const info = await inspectUpload(f.name, data);
      if (info.kind === 'image') {
        if (out.images.length >= MAX_IMAGES) out.notes.push(`${f.name}: 이미지는 ${MAX_IMAGES}장까지만 볼 수 있어요`);
        else out.images.push(`data:${info.mime};base64,${data.toString('base64')}`);
      } else {
        out.docs.push({ name: f.name, text: info.text ?? '' });
      }
    } catch (err) {
      // 파일 검사가 한국어로 알려 주는 이유(HttpError)나 내려받기 실패 이유를 그대로 전한다
      out.notes.push(`${f.name}: ${(err as Error).message}`);
    }
  }
  return out;
}

// ───────── 모델에게 보낼 글 만들기 + 길이 맞추기 ─────────

/** 모델이 입력에 쓸 수 있는 토큰 (대화 길이에서 답변 자리와 도구 설명 자리를 뺀 값) */
export const inputBudgetTokens = () => Math.max(2000, config.LLM_CONTEXT_TOKENS - config.LLM_MAX_OUTPUT_TOKENS - 500);

export const DEFAULT_ASK_WITH_FILES = '첨부한 파일을 확인하고 내용을 알려 주세요.';

export interface UserTurn {
  /** 모델에게 보낼 사용자 메시지 */
  content: string | ContentPart[];
  /** 대화 기억에 남길 글 (파일 내용은 빼고 이름만) */
  remember: string;
  /** 모델 입력 토큰 추정 */
  tokens: number;
}

/**
 * 질문 + 첨부를 모델에게 보낼 한 메시지로 만든다. 문서는 질문과 관련된 부분만 골라 docBudgetTokens 안에 넣는다.
 */
export function buildUserTurn(question: string, prep: Prepared, docBudgetTokens: number): UserTurn {
  const perDocTokens = prep.docs.length ? Math.floor(Math.max(0, docBudgetTokens) / prep.docs.length) : 0;
  // 한글은 글자당 0.9토큰으로 어림하니, 같은 값으로 글자 수를 되돌린다 (영어는 더 여유롭다)
  const perDocChars = Math.min(Math.floor(config.ATTACH_CONTEXT_CHARS / Math.max(1, prep.docs.length)), Math.max(200, Math.floor(perDocTokens / 0.9)));
  const parts: string[] = [question];
  for (const d of prep.docs) {
    const { text, trimmed } = selectRelevant(d.text, question, perDocChars);
    parts.push(`[첨부 문서: ${d.name}${trimmed ? ` — 전체 ${d.text.length.toLocaleString()}자 중 질문과 관련된 부분만` : ''}]\n"""\n${text}\n"""`);
  }
  if (prep.images.length) parts.push(`[이미지 ${prep.images.length}장을 함께 보냈어요]`);
  for (const n of prep.notes) parts.push(`[첨부 안내: ${n}]`);
  const text = parts.join('\n\n');
  const content: string | ContentPart[] = prep.images.length
    ? [{ type: 'text', text }, ...prep.images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
    : text;
  const remember = prep.names.length ? `${question}\n[첨부: ${prep.names.join(', ')}]` : question;
  return { content, remember, tokens: estimateTokens(text) + prep.images.length * IMAGE_TOKENS };
}

/** 지난 대화를 오래된 것부터 버려서 budgetTokens 안에 들게 한다 (질문·시스템 글은 따로 계산해서 넘긴다) */
export function fitHistory(history: Turn[], budgetTokens: number): Turn[] {
  const turns = [...history];
  const cost = () => turns.reduce((n, t) => n + estimateTokens(t.content), 0);
  while (turns.length > 0 && cost() > budgetTokens) turns.splice(0, Math.min(2, turns.length));
  return turns;
}

// ───────── 모델이 파일을 올리는 도구 ─────────

export interface OutFile {
  name: string;
  data: Buffer;
}

const MAX_OUT_FILES = 4;
const MAX_OUT_BYTES = 1_000_000;
/** 열기만 해도 실행되는 종류는 보내지 않는다 (글로 된 파일만 만든다) */
const BLOCKED_EXT = new Set(['exe', 'dll', 'msi', 'scr', 'com', 'lnk', 'vbs', 'bat', 'cmd', 'jar', 'apk', 'app', 'pif', 'reg']);

export function safeFileName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  name = name.replace(/[\\/]/g, '_').replace(/[:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+/, '').trim();
  if (!name) name = 'file.txt';
  if (name.length > 80) {
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? '';
    name = name.slice(0, 80 - ext.length) + ext;
  }
  if (!/\.[A-Za-z0-9]{1,10}$/.test(name)) name += '.txt';
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)![1]!.toLowerCase();
  if (BLOCKED_EXT.has(ext)) name = name.replace(/\.[A-Za-z0-9]+$/, '') + '.txt';
  return name;
}

export const SEND_FILE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'send_file',
    description:
      '디스코드 대화에 글로 된 파일을 첨부해서 올린다. 긴 코드·문서·표(CSV)·설정 파일처럼 메시지에 다 담기 어렵거나 사용자가 파일로 달라고 할 때 쓴다. ' +
      '파일 하나에 글 내용만 담을 수 있다 (이미지·PDF·엑셀·압축 파일은 만들 수 없다). 한 답변에 최대 4개. 파일을 올린 뒤에는 무엇을 올렸는지 한두 문장으로 알려 준다.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: '파일 이름과 확장자 (예: report.md, main.py, data.csv)' },
        content: { type: 'string', description: '파일에 들어갈 글 전체' },
      },
      required: ['filename', 'content'],
    },
  },
};

/** send_file 호출 하나를 처리해 파일을 모으고, 모델에게 돌려줄 결과 글을 만든다 */
export function handleSendFile(argsJson: string, out: OutFile[]): string {
  let args: { filename?: unknown; content?: unknown };
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    return '오류: 인자가 올바른 JSON 이 아니에요';
  }
  if (typeof args.content !== 'string' || !args.content) return '오류: content(파일에 들어갈 글)가 비어 있어요';
  if (out.length >= MAX_OUT_FILES) return `오류: 한 답변에는 파일을 ${MAX_OUT_FILES}개까지만 올릴 수 있어요`;
  const data = Buffer.from(args.content, 'utf8');
  if (data.length > MAX_OUT_BYTES) return `오류: 파일이 너무 커요 (${Math.round(data.length / 1024)}KB, 최대 ${MAX_OUT_BYTES / 1_000_000}MB). 나눠서 올려 주세요`;
  let name = safeFileName(args.filename);
  // 같은 이름이 있으면 번호를 붙인다
  const taken = new Set(out.map((f) => f.name));
  if (taken.has(name)) {
    const m = /^(.*?)(\.[A-Za-z0-9]+)$/.exec(name)!;
    for (let i = 2; taken.has(name); i++) name = `${m[1]} (${i})${m[2]}`;
  }
  out.push({ name, data });
  return `파일 "${name}" (${data.length.toLocaleString()}바이트)을 대화에 올렸어요. 사용자에게 한두 문장으로 알려 주세요.`;
}
