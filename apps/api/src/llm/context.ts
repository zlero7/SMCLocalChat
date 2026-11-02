import { config } from '../config.js';
import { localFolderPrompt } from './tools.js';
import { effortPrompt, type Effort } from './effort.js';
import { gmailPrompt } from './gmailTools.js';
import { webSearchPrompt } from './webTools.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 사용자 메시지에 붙인 이미지 (data: URL). 모델에 보낼 때 그림 조각으로 바뀐다 */
  images?: string[];
}

/** 그림을 함께 보내는 사용자 메시지의 조각 (OpenAI 형식) */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** 도구를 쓰는 동안 모델과 주고받는 메시지 (도구 호출, 도구 결과 포함) */
export type ModelMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'user'; content: ContentPart[] }
  | {
      role: 'assistant';
      content: string;
      tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * 토크나이저 없이 쓰는 보수적인 토큰 추정.
 * 영문/숫자는 글자당 약 0.3토큰, 한글 등은 약 0.9토큰으로 넉넉하게 잡는다.
 */
export function estimateTokens(text: string): number {
  let t = 0;
  for (const ch of text) t += (ch.codePointAt(0) ?? 0) < 128 ? 0.3 : 0.9;
  return Math.ceil(t);
}

/** 이미지 한 장이 차지하는 토큰 (브라우저가 긴 변 1280px 이하로 줄여 보낸다는 가정의 넉넉한 값) */
export const IMAGE_TOKENS = 1300;

/** 모델에 보낼 형식으로 바꾼다 (이미지가 있는 메시지는 글 + 그림 조각) */
export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((m) =>
    m.role === 'user' && m.images?.length
      ? {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: m.content },
            ...m.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ],
        }
      : { role: m.role, content: m.content },
  );
}

/** 모델 메시지의 글 부분 (그림 조각은 뺀다) */
export const textOf = (content: string | ContentPart[]) =>
  typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');

export interface PromptOptions {
  /** 사용자가 직접 적은 개인 지침 */
  customInstruction: string;
  /** 고른 응답 스타일 (기본 스타일은 지침이 비어 있다) */
  style?: { name: string; instruction: string };
  /** 사용자가 브라우저에서 권한을 준 내 컴퓨터 폴더 이름 (없으면 null) */
  localFolder?: string | null;
  /** 웹 검색 도구를 쓸 수 있는지 */
  webSearch?: boolean;
  /** Gmail 도구를 쓸 수 있으면 연결된 메일 주소 */
  gmailEmail?: string | null;
  /** 예약 작업으로 자동 실행될 때 그 작업의 이름 */
  scheduledTitle?: string;
  /** 긴 대화의 앞부분 요약 (그 뒤 메시지만 그대로 보낸다) */
  summary?: string | null;
  /** 대화가 속한 프로젝트의 지침과 자료 (자료가 많으면 질문과 관련된 부분만) */
  project?: { name: string; instructions: string; knowledge: string; trimmed: boolean } | null;
  /** 지난 대화들에서 기억해 둔 사용자에 대한 사실 */
  memories?: string[];
  /** 노력(생각 깊이). 깊게·최대면 검산하라는 지시가 붙는다 */
  effort?: Effort;
}

export function buildSystemPrompt({
  customInstruction,
  style,
  localFolder,
  webSearch,
  scheduledTitle,
  summary,
  project,
  memories,
  effort,
  gmailEmail,
}: PromptOptions): string {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  let prompt =
    '당신은 친절하고 정확한 AI 어시스턴트입니다. 사용자가 쓰는 언어로 답하세요. ' +
    '필요하면 마크다운(목록, 표, 코드 블록)을 사용하세요. 모르는 것은 아는 척하지 말고 모른다고 말하세요.\n' +
    `오늘 날짜: ${today} (Asia/Seoul)`;
  const styleText = style?.instruction.trim();
  if (styleText) prompt += `\n\n[응답 스타일: ${style!.name}]\n${styleText}`;
  const custom = customInstruction.trim();
  if (memories?.length) {
    prompt +=
      '\n\n[사용자에 대해 기억하는 것]\n지난 대화에서 알게 된 내용이다. 관련 있을 때만 자연스럽게 활용하고, 기억하고 있다는 말을 굳이 하지 않는다.\n' +
      memories.map((m) => `- ${m}`).join('\n');
  }
  // 개인 지침을 스타일보다 뒤에 둬서, 둘이 부딪히면 사용자가 직접 쓴 지침이 우선하게 한다
  if (custom) prompt += `\n\n[사용자 개인 지침]\n${custom}`;
  if (project) {
    prompt += `\n\n[프로젝트: ${project.name}]\n이 대화는 사용자의 "${project.name}" 프로젝트 안에서 나누는 대화다.`;
    if (project.instructions.trim()) prompt += `\n\n[프로젝트 지침]\n${project.instructions.trim()}`;
    if (project.knowledge) {
      prompt +=
        `\n\n[프로젝트 자료${project.trimmed ? ' — 자료가 많아서 지금 질문과 관련된 부분만 골랐다' : ''}]\n` +
        '답할 때 이 자료를 근거로 쓰고, 자료에 없는 내용은 없다고 말한다.\n' +
        project.knowledge;
    }
  }
  const depth = effort ? effortPrompt(effort) : '';
  if (depth) prompt += `\n\n${depth}`;
  if (localFolder) prompt += `\n\n${localFolderPrompt(localFolder)}`;
  if (webSearch) prompt += `\n\n${webSearchPrompt()}`;
  if (gmailEmail) prompt += `\n\n${gmailPrompt(gmailEmail)}`;
  if (scheduledTitle) {
    prompt +=
      `\n\n[예약 작업: ${scheduledTitle}]\n` +
      '이 요청은 사용자가 미리 예약해 둔 작업이 정해진 시각에 자동으로 실행된 것입니다. ' +
      '사용자는 지금 대화에 없으므로 되묻거나 확인을 구하지 말고, 지시대로 바로 완성된 결과물을 답하세요.';
  }
  if (summary) {
    prompt +=
      '\n\n[앞선 대화 요약]\n이 대화는 길어서 앞부분을 아래처럼 요약해 두었다. 요약 내용도 이 대화에서 실제로 나눈 이야기로 여기고 이어서 답한다.\n' +
      summary;
  }
  return prompt;
}

/**
 * 시스템 프롬프트 + 최근 대화를 컨텍스트 예산 안에 맞춰 만든다.
 * 예산을 넘으면 오래된 메시지부터 잘라내고, 가장 최근 메시지는 항상 남긴다.
 */
export function buildMessages(options: PromptOptions, history: ChatMessage[]): ChatMessage[] {
  const system = buildSystemPrompt(options);
  const budget = config.LLM_CONTEXT_TOKENS - config.LLM_MAX_OUTPUT_TOKENS - estimateTokens(system) - 64;

  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    const cost = estimateTokens(msg.content) + (msg.images?.length ?? 0) * IMAGE_TOKENS + 8;
    if (used + cost > budget && kept.length > 0) break;
    kept.unshift(msg);
    used += cost;
  }
  // 잘린 뒤 assistant 답변으로 시작하면 어색하므로 user 로 시작하게 맞춘다
  while (kept.length > 1 && kept[0]!.role !== 'user') kept.shift();

  return [{ role: 'system', content: system }, ...kept];
}
