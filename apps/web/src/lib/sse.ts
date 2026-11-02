import type { Effort } from '../store/effort';
import { ApiError, authedFetch } from './api';
import type { MessageStatus, ToolExec, ToolStep } from './types';

export interface StreamHandlers {
  onQueue(position: number): void;
  onStart(): void;
  /** 모델이 메모리에 없어 불러오는 중 (첫 글자까지 몇 분 걸릴 수 있음) */
  onLoading(): void;
  /** 대화가 길어서 앞부분을 요약하는 중 */
  onCompacting(): void;
  /** AI 가 사용자 PC 폴더에서 파일 작업을 하려 함 (브라우저가 실행하고 결과를 서버에 보낸다) */
  onToolExec(request: ToolExec): void;
  /** 서버가 웹 도구(검색·페이지 읽기)를 실행하기 시작함 */
  onToolStart(step: Pick<ToolStep, 'id' | 'name' | 'args'>): void;
  /** 도구 하나가 끝남 (허용 요청한 작업이면 그 결과) */
  onToolResult(step: ToolStep): void;
  onReasoning(text: string): void;
  onDelta(text: string): void;
  onTitle(title: string): void;
  /** 답변이 끝난 뒤 사용자에 대해 새로 기억한 것 */
  onMemory(items: { id: string; content: string }[]): void;
  onError(message: string): void;
  onDone(info: { messageId: string | null; status: MessageStatus }): void;
}

/**
 * 메시지를 보내고 SSE 응답을 끝까지 읽는다. (EventSource 는 POST 를 못 쓰므로 fetch 로 직접 파싱)
 * 요청이 거절되면(400/409/429 등) ApiError 를 던지고, 스트림 도중 끊기면 일반 Error 를 던진다.
 */
/** 서버에 보내는 메시지 요청 (값이 없는 항목은 보내지 않는다) */
export interface SendBody {
  content?: string;
  model?: string;
  localFolder?: string;
  webSearch?: boolean;
  /** 노력(생각 깊이) */
  effort?: Effort;
  /** Gmail 도구 쓰기 */
  gmail?: boolean;
  /** 마지막 답변을 지우고 같은 질문으로 다시 만들기 */
  regenerate?: boolean;
  /** 이 사용자 메시지부터 뒤를 지우고 content 로 고쳐서 다시 시작 */
  editMessageId?: string;
  /** 붙인 파일 id (먼저 /files 로 올려 둔 것) */
  attachmentIds?: string[];
}

export async function streamMessage(
  conversationId: string,
  body: SendBody,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authedFetch(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(data?.error ?? '메시지를 보내지 못했어요', res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const dispatch = (event: string, raw: string) => {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    switch (event) {
      case 'queue':
        return handlers.onQueue(Number(data.position) || 0);
      case 'start':
        return handlers.onStart();
      case 'loading':
        return handlers.onLoading();
      case 'compacting':
        return handlers.onCompacting();
      case 'tool_exec':
        return handlers.onToolExec(data as ToolExec);
      case 'tool_start':
        return handlers.onToolStart({ id: String(data.id), name: String(data.name), args: data.args ?? {} });
      case 'tool_result':
        return handlers.onToolResult(data as ToolStep);
      case 'reasoning':
        return handlers.onReasoning(String(data.text ?? ''));
      case 'delta':
        return handlers.onDelta(String(data.text ?? ''));
      case 'title':
        return handlers.onTitle(String(data.title ?? ''));
      case 'memory':
        return handlers.onMemory(Array.isArray(data.items) ? data.items : []);
      case 'error':
        return handlers.onError(String(data.message ?? '문제가 생겼어요'));
      case 'done':
        return handlers.onDone({ messageId: data.messageId ?? null, status: data.status });
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) dispatch(event, data);
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error('답변을 받는 중 연결이 끊겼어요.');
  }
}
