import { config } from '../config.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 글이 올라온 날짜 (검색 엔진이 알려 줄 때만) */
  published?: string;
}

/** 웹 검색을 쓸 수 있게 설정됐는지 */
export const webSearchConfigured =
  config.WEB_SEARCH_PROVIDER === 'searxng'
    ? config.WEB_SEARCH_URL !== ''
    : config.WEB_SEARCH_PROVIDER !== 'none' && config.WEB_SEARCH_API_KEY !== '';

const TIMEOUT_MS = 12_000;

export class SearchError extends Error {}

const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

async function getJson(url: string, init: RequestInit, signal: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new SearchError('검색 서버에 연결하지 못했어요');
  }
  if (!res.ok) throw new SearchError(`검색 서버가 오류를 돌려줬어요 (${res.status})`);
  return res.json();
}

async function searxng(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const url = `${config.WEB_SEARCH_URL}/search?${new URLSearchParams({ q: query, format: 'json', safesearch: '0' })}`;
  const data = await getJson(url, {}, signal);
  return (Array.isArray(data.results) ? data.results : []).map((r: any) => ({
    title: clean(r.title),
    url: String(r.url ?? ''),
    snippet: clean(r.content),
    published: r.publishedDate ? String(r.publishedDate).slice(0, 10) : undefined,
  }));
}

// 아래 두 곳은 API 키가 있어야 해서 이 설치에서는 실제로 시험하지 못했다 (각 서비스의 공개 문서 형식대로 작성)
async function tavily(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const data = await getJson(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.WEB_SEARCH_API_KEY}` },
      body: JSON.stringify({ query, max_results: config.WEB_SEARCH_RESULTS }),
    },
    signal,
  );
  return (Array.isArray(data.results) ? data.results : []).map((r: any) => ({
    title: clean(r.title),
    url: String(r.url ?? ''),
    snippet: clean(r.content),
    published: r.published_date ? String(r.published_date).slice(0, 10) : undefined,
  }));
}

async function brave(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(config.WEB_SEARCH_RESULTS) })}`;
  const data = await getJson(
    url,
    { headers: { Accept: 'application/json', 'X-Subscription-Token': config.WEB_SEARCH_API_KEY } },
    signal,
  );
  return (Array.isArray(data.web?.results) ? data.web.results : []).map((r: any) => ({
    title: clean(r.title),
    url: String(r.url ?? ''),
    snippet: clean(String(r.description ?? '').replace(/<[^>]+>/g, '')),
    published: r.page_age ? String(r.page_age).slice(0, 10) : undefined,
  }));
}

/** 검색해서 주소가 겹치지 않는 결과를 WEB_SEARCH_RESULTS 개까지 돌려준다 */
export async function webSearch(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  if (!webSearchConfigured) throw new SearchError('웹 검색이 설정되지 않았어요');
  const provider = config.WEB_SEARCH_PROVIDER;
  const raw = provider === 'searxng' ? await searxng(query, signal) : provider === 'tavily' ? await tavily(query, signal) : await brave(query, signal);
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of raw) {
    if (!/^https?:\/\//i.test(r.url) || !r.title) continue;
    const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, snippet: r.snippet.slice(0, 300) });
    if (out.length >= config.WEB_SEARCH_RESULTS) break;
  }
  return out;
}
