import { create } from 'zustand';

const KEY = 'webSearch';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

interface WebSearchStore {
  /** 사이트에 웹 검색이 설정돼 있는지 (서버 /status 가 알려 준다) */
  available: boolean;
  /** 사용자가 켜 두었는지 (브라우저에 기억) */
  enabled: boolean;
  setAvailable(available: boolean): void;
  toggle(): void;
}

export const useWebSearch = create<WebSearchStore>((set, get) => ({
  available: false,
  enabled: read(),
  setAvailable(available) {
    if (get().available !== available) set({ available });
  },
  toggle() {
    const enabled = !get().enabled;
    try {
      localStorage.setItem(KEY, enabled ? 'on' : 'off');
    } catch {}
    set({ enabled });
  },
}));

/** 이번 메시지에 웹 검색을 쓸지 */
export const webSearchActive = (s: Pick<WebSearchStore, 'available' | 'enabled'>) => s.available && s.enabled;
