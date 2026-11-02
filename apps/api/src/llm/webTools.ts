/**
 * AI 가 쓸 수 있는 웹 도구. 파일 도구(tools.ts)와 달리 서버가 직접 실행한다.
 */
import { FetchError, fetchPage } from '../web/fetch.js';
import { SearchError, webSearch } from '../web/search.js';

export const WEB_TOOL_NAMES = ['web_search', 'fetch_url'] as const;

export const webToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '인터넷을 검색해 제목·주소·요약 목록을 받는다. 최신 소식, 가격, 일정, 사실 확인처럼 모르거나 바뀌었을 수 있는 정보가 필요할 때 쓴다.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '짧고 핵심만 담은 검색어 (필요하면 영어로)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '웹 페이지 하나를 열어 본문 글자를 읽는다. 검색 요약만으로 부족할 때 믿을 만한 결과의 주소를 읽는다.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '읽을 페이지 주소 (http/https)' } },
        required: ['url'],
      },
    },
  },
];

export const isWebTool = (name: string) => (WEB_TOOL_NAMES as readonly string[]).includes(name);

export function webSearchPrompt(): string {
  return (
    '[웹 검색]\n이 대화에서는 web_search(검색)와 fetch_url(페이지 읽기) 도구를 쓸 수 있다. ' +
    '최신 정보, 뉴스, 가격, 날씨, 일정, 제품·인물 정보처럼 바뀌었을 수 있거나 잘 모르는 내용은 추측하지 말고 먼저 검색한다. ' +
    '검색 요약만으로 부족하면 가장 믿을 만한 페이지를 1~3개 fetch_url 로 읽는다. ' +
    '답에는 근거로 쓴 출처를 [제목](주소) 형식의 링크로 붙이고, 검색 결과에 없는 내용은 지어내지 않는다. ' +
    '결과가 서로 다르면 다르다고 밝힌다. "검색해 보겠습니다"라고 말만 하지 말고 바로 도구를 호출한다.'
  );
}

export interface WebSource {
  title: string;
  url: string;
}

export interface WebToolOutcome {
  status: 'ok' | 'error';
  /** 모델에게 돌려줄 글 */
  result: string;
  /** 화면에 보여 줄 한 줄 요약 */
  summary: string;
  /** 화면에 출처로 보여 줄 검색 결과 (모델이 답에 링크를 빠뜨려도 사용자는 볼 수 있게) */
  sources?: WebSource[];
}

/** 화면에 출처로 보여 줄 검색 결과 수 */
const SHOWN_SOURCES = 5;

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

export async function runWebTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<WebToolOutcome> {
  try {
    if (name === 'web_search') {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { status: 'error', result: '오류: query(검색어)가 비어 있어요', summary: '검색어 없음' };
      const results = await webSearch(query.slice(0, 300), signal);
      if (results.length === 0) {
        return { status: 'ok', result: `검색어 "${query}" 로 찾은 결과가 없습니다. 다른 검색어로 다시 시도하세요.`, summary: '결과 없음' };
      }
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}${r.published ? ` (${r.published})` : ''}\n   주소: ${r.url}\n   요약: ${r.snippet || '(요약 없음)'}`,
      );
      return {
        status: 'ok',
        result: `검색어 "${query}" 결과 ${results.length}개:\n\n${lines.join('\n\n')}`,
        summary: `${results.length}개 · ${[...new Set(results.slice(0, 3).map((r) => hostOf(r.url)))].join(', ')}`,
        sources: results.slice(0, SHOWN_SOURCES).map((r) => ({ title: r.title.slice(0, 120), url: r.url })),
      };
    }
    if (name === 'fetch_url') {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url) return { status: 'error', result: '오류: url(주소)가 비어 있어요', summary: '주소 없음' };
      const page = await fetchPage(url, signal);
      if (!page.text) return { status: 'ok', result: `${page.url} 에서 읽을 수 있는 글이 없습니다.`, summary: '글 없음' };
      return {
        status: 'ok',
        result:
          `제목: ${page.title || '(제목 없음)'}\n주소: ${page.url}\n\n${page.text}` +
          (page.truncated ? '\n\n…(길어서 뒷부분은 생략함)' : ''),
        summary: `${page.title || hostOf(page.url)}`.slice(0, 80),
      };
    }
    return { status: 'error', result: `오류: 모르는 도구예요 (${name})`, summary: '모르는 도구' };
  } catch (err) {
    if (signal.aborted) throw err;
    const message = err instanceof SearchError || err instanceof FetchError ? err.message : '처리 중 문제가 생겼어요';
    if (!(err instanceof SearchError || err instanceof FetchError)) console.error(`[web] ${name} 실패:`, (err as Error).message);
    return { status: 'error', result: `오류: ${message}`, summary: message };
  }
}
