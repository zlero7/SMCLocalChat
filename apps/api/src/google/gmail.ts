/** Gmail 읽기 (검색, 메일 하나 읽기). 보내기·지우기 같은 기능은 없다 (권한도 읽기만 받는다) */
import { htmlToText } from '../web/fetch.js';
import { gmailAccessToken } from './oauth.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BODY_MAX_CHARS = 6000;

export class GmailError extends Error {}

async function call(userId: string, path: string, params: Record<string, string | string[]>, signal: AbortSignal): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const one of Array.isArray(v) ? v : [v]) qs.append(k, one);
  const token = await gmailAccessToken(userId);
  const res = await fetch(`${API}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (res.status === 404) throw new GmailError('그 메일을 찾을 수 없어요.');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[gmail] HTTP ${res.status}`, body.slice(0, 200));
    throw new GmailError(res.status === 403 ? 'Gmail 이 요청을 거절했어요 (권한이나 사용량 한도).' : `Gmail 오류 (${res.status})`);
  }
  return res.json();
}

const header = (headers: { name: string; value: string }[] | undefined, name: string) =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

/** Gmail 검색 문법(from:, subject:, newer_than:2d, is:unread …)으로 찾는다 */
export async function searchMail(userId: string, query: string, max: number, signal: AbortSignal): Promise<MailSummary[]> {
  const list = await call(userId, '/messages', { q: query, maxResults: String(max) }, signal);
  const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);
  return Promise.all(
    ids.map(async (id) => {
      const m = await call(userId, `/messages/${id}`, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }, signal);
      return {
        id,
        from: header(m.payload?.headers, 'From'),
        subject: header(m.payload?.headers, 'Subject') || '(제목 없음)',
        date: header(m.payload?.headers, 'Date'),
        snippet: String(m.snippet ?? ''),
        unread: Array.isArray(m.labelIds) && m.labelIds.includes('UNREAD'),
      };
    }),
  );
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
}

function decodePart(p: Part): string {
  if (!p.body?.data) return '';
  const bytes = Buffer.from(p.body.data, 'base64url');
  const charset = /charset="?([\w-]+)/i.exec(header(p.headers, 'Content-Type'))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** 본문(글자 우선, 없으면 HTML 을 글자로)과 첨부 파일 이름을 모은다 */
function walk(p: Part, out: { plain: string[]; html: string[]; files: string[] }) {
  if (p.filename) {
    out.files.push(p.filename);
    return;
  }
  if (p.mimeType === 'text/plain') out.plain.push(decodePart(p));
  else if (p.mimeType === 'text/html') out.html.push(decodePart(p));
  for (const child of p.parts ?? []) walk(child, out);
}

export interface Mail {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
  truncated: boolean;
  attachments: string[];
}

export async function readMail(userId: string, id: string, signal: AbortSignal): Promise<Mail> {
  if (!/^[0-9a-zA-Z]{6,40}$/.test(id)) throw new GmailError('메일 id 가 올바르지 않아요. 먼저 gmail_search 로 찾은 id 를 쓰세요.');
  const m = await call(userId, `/messages/${id}`, { format: 'full' }, signal);
  const out = { plain: [] as string[], html: [] as string[], files: [] as string[] };
  walk(m.payload ?? {}, out);
  const raw = out.plain.join('\n').trim() || htmlToText(out.html.join('\n')).text || String(m.snippet ?? '');
  const body = raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const h = m.payload?.headers;
  return {
    id,
    from: header(h, 'From'),
    to: header(h, 'To'),
    cc: header(h, 'Cc'),
    subject: header(h, 'Subject') || '(제목 없음)',
    date: header(h, 'Date'),
    body: body.slice(0, BODY_MAX_CHARS),
    truncated: body.length > BODY_MAX_CHARS,
    attachments: out.files,
  };
}
