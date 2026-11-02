/**
 * 노력(생각 깊이): Claude 의 effort 처럼 AI 가 답하기 전에 얼마나 생각할지 고른다.
 * 생각 예산을 넘기면 그 자리에서 생각을 멈추고, 그때까지 생각한 것을 바탕으로 바로 답을 쓰게 한다.
 */
import { streamChat, type StreamEvent } from './client.js';
import { estimateTokens } from './context.js';

export const EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = 'medium';

/** 생각에 쓸 수 있는 토큰 (0 = 생각하지 않음, null = 제한 없음) */
export const THINKING_BUDGET: Record<Effort, number | null> = {
  low: 0,
  medium: 1200,
  high: 4000,
  max: null,
};

/** 깊게 생각할 때 시스템 프롬프트에 덧붙이는 지시 */
export function effortPrompt(effort: Effort): string {
  if (effort !== 'high' && effort !== 'max') return '';
  return (
    '[생각 깊이: ' + (effort === 'max' ? '최대' : '깊게') + ']\n' +
    '답하기 전에 충분히 생각한다. 어려운 질문이면 여러 풀이나 관점을 비교하고, 계산·사실·코드는 한 번 더 검산한 뒤 답한다.'
  );
}

type StreamOpts = Parameters<typeof streamChat>[0];

/**
 * 노력에 맞춰 모델을 부른다.
 * 생각이 예산을 넘으면 그 요청을 끊고, 생각한 내용을 닫힌 생각으로 넘겨 답만 이어 쓰게 한다.
 * (도구를 쓰는 대화는 미리 채우기가 도구 호출을 깨뜨릴 수 있어 생각 없이 다시 부른다)
 */
export async function* streamWithEffort(opts: StreamOpts & { effort: Effort }): AsyncGenerator<StreamEvent> {
  const budget = THINKING_BUDGET[opts.effort];
  const think = opts.enableThinking && budget !== 0;
  if (!think || budget === null) {
    yield* streamChat({ ...opts, enableThinking: think });
    return;
  }

  // 사용자가 멈추면 같이 멈추고, 예산을 넘기면 우리가 멈추는 연결
  const inner = new AbortController();
  const forward = () => inner.abort();
  opts.signal.addEventListener('abort', forward, { once: true });
  let reasoning = '';
  let answered = false;
  let cut = false;
  try {
    for await (const ev of streamChat({ ...opts, signal: inner.signal })) {
      if (ev.type === 'reasoning') {
        reasoning += ev.text;
        yield ev;
        if (!answered && estimateTokens(reasoning) > budget) {
          cut = true;
          inner.abort();
          break;
        }
      } else {
        if (ev.type === 'delta' || ev.type === 'tool_calls') answered = true;
        yield ev;
      }
    }
  } catch (err) {
    if (!cut || opts.signal.aborted) throw err;
  } finally {
    opts.signal.removeEventListener('abort', forward);
  }
  if (!cut) return;
  if (opts.signal.aborted) throw new Error('aborted');

  // 끊은 요청은 사용량을 알려 주지 않으므로 생각한 만큼 어림해서 더한다
  yield { type: 'usage', promptTokens: 0, completionTokens: estimateTokens(reasoning) };
  console.log(`[effort] 생각 예산(${budget}토큰)을 다 써서 답을 쓰게 함 (${opts.effort})`);
  if (opts.tools?.length) {
    yield* streamChat({ ...opts, enableThinking: false });
    return;
  }
  yield* streamChat({ ...opts, continueAfterThinking: reasoning });
}
