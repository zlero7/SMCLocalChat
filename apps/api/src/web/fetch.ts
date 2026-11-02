import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch } from 'undici';
import { config } from '../config.js';

/**
 * AI 가 고른 웹 페이지를 읽어 본문 글자만 돌려준다.
 * 이 서버 자신(localhost)이나 사설망(공유기·다른 PC) 주소는 읽지 못하게 막는다:
 * 주소 이름이 실제로 어느 IP 로 가는지 연결하는 순간에 확인하므로, 리다이렉트나 DNS 바꿔치기로도 못 들어간다.
 */

export class FetchError extends Error {}

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** 공개 인터넷 주소가 아니면 true */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || // 이 PC / 사설망
      (a === 100 && b >= 64 && b <= 127) || // 통신사 공유 주소
      (a === 169 && b === 254) || // 링크 로컬 (클라우드 메타데이터 포함)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // 멀티캐스트·예약
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return (
      v === '::' || v === '::1' ||
      v.startsWith('fc') || v.startsWith('fd') || // 사설
      v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || // 링크 로컬
      v.startsWith('ff') // 멀티캐스트
    );
  }
  return true;
}

// 연결할 때마다 주소를 확인하는 전용 연결 (리다이렉트로 옮겨 간 주소도 여기서 다시 걸러진다)
const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 4);
        const list = addresses as dns.LookupAddress[];
        const bad = list.find((a) => isBlockedAddress(a.address));
        if (bad || list.length === 0) {
          return callback(new FetchError('내부망·이 PC 주소는 읽을 수 없어요'), '', 4);
        }
        if ((options as { all?: boolean }).all) return (callback as any)(null, list);
        callback(null, list[0]!.address, list[0]!.family);
      });
    },
  },
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
});

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** 태그 하나 (속성값 따옴표 안의 ">" 에서 끊기지 않게) */
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/** HTML 에서 제목과 본문 글자만 뽑는다 (메뉴·광고·스크립트는 최대한 뺀다) */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|canvas|select)\b[\s\S]*?<\/\1>/gi, ' ');
  // 본문 영역이 따로 있으면 그것만 쓴다
  const main = /<(article|main)\b[^>]*>([\s\S]*)<\/\1>/i.exec(body)?.[2];
  if (main && main.replace(TAG, '').trim().length > 400) body = main;
  body = body
    .replace(/<(nav|header|footer|aside|form|button)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|blockquote|pre|dd|dt)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(TAG, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    // 표 테두리나 목록 기호만 남은 줄은 빈 줄로
    .map((l) => (/^[|\-–—·•\s]*$/.test(l) ? '' : l.replace(/\s*\|$/, '')))
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

function charsetOf(contentType: string, head: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const sniff = new TextDecoder('latin1').decode(head.subarray(0, 4096));
  return (/<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8').toLowerCase();
}

export interface PageText {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** 페이지를 읽어 본문 글자를 돌려준다 (WEB_FETCH_MAX_CHARS 까지) */
export async function fetchPage(rawUrl: string, signal: AbortSignal): Promise<PageText> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchError('주소가 올바르지 않아요');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('http/https 주소만 읽을 수 있어요');
  if (url.username || url.password) throw new FetchError('아이디·비밀번호가 들어간 주소는 읽지 않아요');
  // 숫자 IP 를 바로 쓴 주소도 막는다 (연결할 때도 다시 확인한다)
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new FetchError('내부망·이 PC 주소는 읽을 수 없어요');

  let res;
  try {
    res = await fetch(url, {
      dispatcher: guardedAgent,
      redirect: 'follow',
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalChatBot/1.0; +page reader for a private AI chat)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    if (signal.aborted) throw err;
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof FetchError) throw cause;
    throw new FetchError('페이지에 연결하지 못했어요');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError(`페이지가 오류를 돌려줬어요 (${res.status})`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/|application\/(xhtml|xml|json)/i.test(type)) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError(`글이 아닌 파일이라 읽지 않았어요 (${type.split(';')[0] || '형식 모름'})`);
  }

  // 너무 큰 페이지는 앞부분만 받는다
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= MAX_BYTES) break;
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c.subarray(0, Math.min(c.byteLength, size - offset)), offset);
    offset += c.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder(charsetOf(type, bytes)).decode(bytes);
  } catch {
    raw = new TextDecoder('utf-8').decode(bytes);
  }

  const isHtml = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(raw);
  const { title, text } = isHtml ? htmlToText(raw) : { title: '', text: raw.trim() };
  const max = config.WEB_FETCH_MAX_CHARS;
  return { url: res.url || url.toString(), title, text: text.slice(0, max), truncated: text.length > max };
}
