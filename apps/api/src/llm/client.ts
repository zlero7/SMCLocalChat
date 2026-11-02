import { Agent, fetch, type Response } from 'undici';
import { config } from '../config.js';
import { textOf, type ChatMessage, type ModelMessage } from './context.js';
import { stripThink, ThinkSplitter } from './think.js';

export class LlmError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export type StreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  /** 모델이 도구를 부르기로 했다 (한 번에 여러 개일 수 있다). 스트림 마지막에 한 번 온다 */
  | { type: 'tool_calls'; calls: ToolCall[] };

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 문자열 그대로 */
  arguments: string;
}

// 큰 모델은 메모리에 올리는 데만 몇 분이 걸리고, 그동안 모델 서버는 응답 헤더를 보내지 않는다.
// Node 기본 fetch 는 5분이 지나면 끊으므로 모델 호출에는 제한을 넉넉히 둔 연결을 쓴다.
// (사용자가 중단하거나 창을 닫으면 signal 로 바로 끊긴다)
const modelAgent = new Agent({
  headersTimeout: config.LLM_LOAD_TIMEOUT_SEC * 1000,
  bodyTimeout: config.LLM_LOAD_TIMEOUT_SEC * 1000,
});

const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.LLM_API_KEY}`,
});

function requestBody(model: string, messages: ModelMessage[], enableThinking: boolean, extra: Record<string, unknown>) {
  return JSON.stringify({
    model,
    messages,
    // llama.cpp 는 chat_template_kwargs, Ollama 는 reasoning_effort 로 생각 모드를 끈다
    chat_template_kwargs: { enable_thinking: enableThinking },
    ...(enableThinking ? {} : { reasoning_effort: 'none' }),
    ...extra,
  });
}

const CONNECT_ERROR = '모델 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.';

/** OpenAI 호환 /chat/completions 를 stream 으로 호출해 생각/답변/사용량 이벤트를 흘려준다. */
export async function* streamChat(opts: {
  model: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  enableThinking: boolean;
  /** 모델이 쓸 수 있는 도구 (OpenAI tools 형식). 없으면 일반 대화 */
  tools?: unknown[];
  /**
   * 생각을 여기서 끝내고 바로 답을 쓰게 한다 (생각 예산을 다 썼을 때).
   * 이 글을 닫힌 생각(<think>…</think>)으로 미리 채워 보내면 모델은 그 뒤의 답만 이어 쓴다.
   */
  continueAfterThinking?: string;
  /** 요청에 덧붙일 값 (예: 샘플링 temperature, top_p). 서버 기본값을 이 요청에서만 바꿀 때 */
  extra?: Record<string, unknown>;
}): AsyncGenerator<StreamEvent> {
  // Qwen 은 시스템 지시와 상관없이 영어로 생각하는 버릇이 있다.
  // 한국어로 물었으면 생각의 첫 문장을 한국어로 채워 보내서 이어서 한국어로 생각하게 한다.
  // (이어서 오는 생각은 content 안에 오고 </think> 뒤가 답변이다)
  const prefix = config.LLM_THINKING_PREFIX.trim();
  const lastUserMsg = [...opts.messages].reverse().find((m) => m.role === 'user');
  const lastUser = lastUserMsg ? textOf(lastUserMsg.content) : '';
  const useTools = !!opts.tools?.length;
  // 생각 모드가 없는 모델(gemma 등)은 </think> 를 안 닫아서 답변 전체가 생각으로 분류되므로 지정한 모델에만 쓴다
  const prefixModel = config.LLM_THINKING_PREFIX_MODELS.split(',')
    .map((s) => s.trim())
    .some((p) => p !== '' && opts.model.startsWith(p));
  // 도구를 쓸 때는 미리 채우기를 하지 않는다 (도구 호출 형식이 깨질 수 있다)
  const cont = opts.continueAfterThinking;
  const prefill =
    cont === undefined && !useTools && opts.enableThinking && prefix !== '' && prefixModel && /[가-힣]/.test(lastUser);
  const messages: ModelMessage[] =
    cont !== undefined
      ? [...opts.messages, { role: 'assistant', content: `<think>\n${cont.trim()}\n</think>\n\n` }]
      : prefill
        ? [...opts.messages, { role: 'assistant', content: `<think>\n${prefix}\n` }]
        : opts.messages;

  let res: Response;
  try {
    res = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: headers(),
      signal: opts.signal,
      dispatcher: modelAgent,
      body: requestBody(opts.model, messages, opts.enableThinking, {
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: config.LLM_MAX_OUTPUT_TOKENS,
        ...(useTools ? { tools: opts.tools } : {}),
        ...(opts.extra ?? {}),
      }),
    });
  } catch (err) {
    if (opts.signal.aborted) throw err;
    console.error('[llm] 연결 실패:', (err as Error).message);
    throw new LlmError(CONNECT_ERROR);
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    console.error(`[llm] HTTP ${res.status}`, text.slice(0, 200));
    throw new LlmError(`모델 서버가 오류를 돌려줬어요 (${res.status})`, res.status);
  }

  const splitter = new ThinkSplitter(prefill);
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buf = '';
  let finished = false;
  // 도구 호출은 조각으로 나뉘어 오므로 index 별로 모은다
  const calls = new Map<number, ToolCall>();
  if (prefill) yield { type: 'reasoning', text: `${prefix}\n` };

  function* handleLine(line: string): Generator<StreamEvent> {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.error) {
      throw new LlmError(`모델 서버 오류: ${String(json.error.message ?? json.error).slice(0, 100)}`);
    }
    const delta = json.choices?.[0]?.delta;
    if (delta) {
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        splitter.exitThink();
        yield { type: 'reasoning', text: reasoning };
      }
      if (typeof delta.content === 'string' && delta.content) {
        for (const piece of splitter.push(delta.content)) yield { type: piece.kind, text: piece.text };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === 'number' ? tc.index : calls.size;
          const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) call.id = String(tc.id);
          if (tc.function?.name) call.name += String(tc.function.name);
          if (tc.function?.arguments) {
            // 조각 문자열로 오거나(OpenAI), 한 번에 객체로 오는 서버도 있다
            call.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          }
          calls.set(index, call);
        }
      }
    }
    if (json.usage) {
      yield {
        type: 'usage',
        promptTokens: Number(json.usage.prompt_tokens ?? 0),
        completionTokens: Number(json.usage.completion_tokens ?? 0),
      };
    }
  }

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        yield* handleLine(line);
        if (finished) break;
      }
    }
    if (!finished && buf.trim()) yield* handleLine(buf.trim());
    for (const piece of splitter.flush()) yield { type: piece.kind, text: piece.text };
    if (calls.size) {
      const list = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }))
        .filter((c) => c.name);
      if (list.length) yield { type: 'tool_calls', calls: list };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** 제목 생성처럼 짧은 한 번짜리 호출 (stream 아님, 생각 모드 끔) */
export async function completeChat(opts: {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs: number;
}): Promise<string> {
  const res = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    signal: AbortSignal.timeout(opts.timeoutMs),
    body: requestBody(opts.model, opts.messages, false, {
      stream: false,
      max_tokens: opts.maxTokens,
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new LlmError(`모델 서버 오류 (${res.status})`, res.status);
  const json: any = await res.json();
  const content = json.choices?.[0]?.message?.content;
  return typeof content === 'string' ? stripThink(content) : '';
}

let onlineCache: { at: number; online: boolean } | null = null;

/** 모델 서버가 살아있는지 (5초 캐시) */
export async function isModelOnline(): Promise<boolean> {
  if (onlineCache && Date.now() - onlineCache.at < 5000) return onlineCache.online;
  let online = false;
  try {
    const res = await fetch(`${config.LLM_BASE_URL}/models`, {
      headers: headers(),
      signal: AbortSignal.timeout(2000),
    });
    online = res.ok;
  } catch {
    online = false;
  }
  onlineCache = { at: Date.now(), online };
  return online;
}

/**
 * 모델이 지금 메모리에 올라가 있는지 (Ollama 의 /api/ps 로 확인).
 * 올라가 있지 않으면 첫 답변까지 몇 분 걸릴 수 있어 화면에 안내한다.
 * Ollama 가 아니라 확인할 방법이 없으면 null.
 */
export async function isModelLoaded(model: string): Promise<boolean | null> {
  const root = config.LLM_BASE_URL.replace(/\/v1$/, '');
  try {
    const res = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const json: any = await res.json();
    if (!Array.isArray(json.models)) return null;
    return json.models.some((m: any) => m?.name === model || m?.model === model);
  } catch {
    return null;
  }
}
