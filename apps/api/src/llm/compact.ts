/**
 * 긴 대화 자동 요약 (Claude 처럼).
 * 대화가 모델이 한 번에 읽을 수 있는 길이를 넘으면 앞부분을 요약해 두고, 최근 메시지만 그대로 보낸다.
 * 요약은 대화에 저장해 두고, 다시 넘치면 "이전 요약 + 그 뒤 메시지"를 다시 요약한다.
 */
import { config } from '../config.js';
import { completeChat } from './client.js';
import { IMAGE_TOKENS, buildSystemPrompt, estimateTokens, type ChatMessage, type PromptOptions } from './context.js';

export interface SeqMessage extends ChatMessage {
  /** messages.seq (요약이 어디까지인지 기록하는 데 쓴다) */
  seq: string;
}

const msgTokens = (m: ChatMessage) => estimateTokens(m.content) + (m.images?.length ?? 0) * IMAGE_TOKENS + 8;

/** 시스템 프롬프트를 빼고 대화 기록에 쓸 수 있는 토큰 */
export function historyBudget(options: PromptOptions): number {
  return config.LLM_CONTEXT_TOKENS - config.LLM_MAX_OUTPUT_TOKENS - estimateTokens(buildSystemPrompt(options)) - 64;
}

/**
 * 요약이 필요하면 앞에서부터 요약할 메시지 수를 돌려준다 (필요 없으면 0).
 * 최근 메시지는 예산의 절반쯤 남기고, 남기는 부분은 사용자 질문으로 시작하게 맞춘다.
 */
export function compactionSplit(options: PromptOptions, history: SeqMessage[]): number {
  const budget = historyBudget(options);
  const total = history.reduce((sum, m) => sum + msgTokens(m), 0);
  if (total <= budget || history.length < 3) return 0;
  let kept = 0;
  let i = history.length;
  while (i > 0) {
    const cost = msgTokens(history[i - 1]!);
    // 마지막 메시지(지금 질문)는 무조건 남긴다
    if (i < history.length && kept + cost > budget * 0.5) break;
    kept += cost;
    i--;
  }
  while (i < history.length - 1 && history[i]!.role !== 'user') i++;
  return i;
}

/** 요약에 넣을 대화 글 (너무 길면 오래된 쪽을 버린다) */
function transcript(messages: ChatMessage[], maxTokens: number): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const who = m.role === 'user' ? '사용자' : 'AI';
    const pics = m.images?.length ? ` [이미지 ${m.images.length}장 첨부]` : '';
    const line = `${who}:${pics} ${m.content}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) {
      lines.unshift('(…더 오래된 대화는 생략)');
      break;
    }
    lines.unshift(line);
    used += cost;
  }
  return lines.join('\n\n');
}

/** 이전 요약과 요약할 메시지들로 새 요약을 만든다 */
export async function summarize(model: string, previous: string | null, messages: ChatMessage[]): Promise<string> {
  const body = transcript(messages, Math.max(2000, config.LLM_CONTEXT_TOKENS - 4000));
  const raw = await completeChat({
    model,
    messages: [
      {
        role: 'system',
        content:
          '당신은 대화를 요약하는 도우미입니다. 아래는 사용자와 AI 가 나눈 대화의 앞부분입니다. ' +
          '나중에 이 요약만 보고도 대화를 자연스럽게 이어 갈 수 있게, 다음을 빠짐없이 한국어 목록으로 정리하세요: ' +
          '사용자가 원하는 것과 목적, 정해진 결정·사실·숫자·이름·날짜, 다룬 코드·파일·자료 이름, 아직 끝나지 않은 일, ' +
          '사용자의 선호나 말투. 인사말이나 설명 없이 요약만 쓰고, 1,500자를 넘지 마세요.',
      },
      {
        role: 'user',
        content: `${previous ? `[이전 요약]\n${previous}\n\n[그 뒤의 대화]\n` : ''}${body}`,
      },
    ],
    maxTokens: 1200,
    timeoutMs: 180_000,
  });
  const summary = raw.trim();
  if (summary.length < 20) throw new Error('요약이 너무 짧음');
  return summary.slice(0, 3000);
}
