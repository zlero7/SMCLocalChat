import { create } from 'zustand';

/** 방금 답변 뒤에 새로 기억한 것 (그 대화 화면의 마지막 답변 아래에 잠깐 보여 준다) */
interface MemoryNotice {
  convId: string | null;
  items: { id: string; content: string }[];
  show(convId: string, items: { id: string; content: string }[]): void;
  clear(): void;
}

export const useMemoryNotice = create<MemoryNotice>((set) => ({
  convId: null,
  items: [],
  show(convId, items) {
    set({ convId, items });
  },
  clear() {
    set({ convId: null, items: [] });
  },
}));
