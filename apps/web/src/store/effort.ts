import { create } from 'zustand';

/** 노력(생각 깊이): AI 가 답하기 전에 얼마나 생각할지 (서버 llm/effort.ts 와 같게) */
export type Effort = 'low' | 'medium' | 'high' | 'max';

export const EFFORT_OPTIONS: { id: Effort; label: string; description: string }[] = [
  { id: 'low', label: '빠르게', description: '생각하지 않고 바로 답해요. 간단한 질문에' },
  { id: 'medium', label: '보통', description: '잠깐 생각하고 답해요 (기본)' },
  { id: 'high', label: '깊게', description: '충분히 생각하고 검산해요. 어려운 문제에' },
  { id: 'max', label: '최대', description: '시간 제한 없이 끝까지 생각해요. 가장 느려요' },
];

const KEY = 'effort';

function read(): Effort {
  try {
    const v = localStorage.getItem(KEY);
    return EFFORT_OPTIONS.some((o) => o.id === v) ? (v as Effort) : 'medium';
  } catch {
    return 'medium';
  }
}

interface EffortStore {
  effort: Effort;
  select(effort: Effort): void;
}

/** 고른 노력 (브라우저에 기억) */
export const useEffort = create<EffortStore>((set) => ({
  effort: read(),
  select(effort) {
    try {
      localStorage.setItem(KEY, effort);
    } catch {}
    set({ effort });
  },
}));
