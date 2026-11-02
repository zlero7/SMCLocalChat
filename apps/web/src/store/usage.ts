import { create } from 'zustand';
import { api } from '../lib/api';
import type { Usage } from '../lib/types';

interface UsageStore {
  usage: Usage | null;
  /** 서버에서 다시 읽는다 (앱 시작, 답변이 끝날 때, 설정 화면) */
  refresh(): Promise<void>;
  reset(): void;
}

// 초기화 시각이 되면 다시 읽어서 막혀 있던 입력창을 풀어 준다
let resetTimer = 0;

export const useUsage = create<UsageStore>((set, get) => ({
  usage: null,
  async refresh() {
    try {
      const { usage } = await api<{ usage: Usage }>('/me/usage');
      set({ usage });
      window.clearTimeout(resetTimer);
      if (usage.resetAt) {
        // setTimeout 최대치(약 24일)를 넘지 않게, 그리고 초기화 직후 1초 여유
        const wait = Math.min(Date.parse(usage.resetAt) - Date.now() + 1000, 2 ** 31 - 1);
        if (wait > 0) resetTimer = window.setTimeout(() => void get().refresh(), wait);
      }
    } catch {
      /* 사용량을 못 읽어도 채팅은 계속 쓸 수 있다 (서버가 최종 확인한다) */
    }
  },
  reset() {
    window.clearTimeout(resetTimer);
    set({ usage: null });
  },
}));

/**
 * 지금 메시지를 보낼 수 없을 만큼 다 썼는지. 막혀 있으면 안내 문구, 아니면 null.
 * (화면에서 미리 막는 용도이고, 최종 판단은 서버가 한다)
 */
export function usageBlockReason(u: Usage | null): string | null {
  if (!u) return null;
  if (u.limit === 0) return '관리자가 이 계정의 사용을 막아 두었어요.';
  if (!u.resetAt || Date.parse(u.resetAt) <= Date.now()) return null; // 창이 끝났으면 다음 메시지부터 새로 시작
  if (u.used < u.limit) return null;
  return `5시간 사용량을 모두 썼어요. ${formatResetAt(u.resetAt)}에 다시 쓸 수 있어요.`;
}

/** 사용 비율 0~1 (제한이 0 이면 1) */
export const usageRatio = (u: Usage) => (u.limit === 0 ? 1 : Math.min(1, u.used / u.limit));

/** "오후 9:40" 처럼 초기화 시각 (날짜가 다르면 날짜도) */
export function formatResetAt(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('ko-KR', {
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** 1234 → "1,234", 123456 → "12.3만" */
export function formatTokens(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}만`;
  return n.toLocaleString('ko-KR');
}
