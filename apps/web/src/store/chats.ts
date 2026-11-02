import { create } from 'zustand';
import { api } from '../lib/api';
import type { Conversation } from '../lib/types';

interface ListResponse {
  items: Conversation[];
  nextCursor: string | null;
}

const byUpdatedDesc = (a: Conversation, b: Conversation) => +new Date(b.updatedAt) - +new Date(a.updatedAt);

interface ChatsState {
  items: Conversation[];
  nextCursor: string | null;
  loading: boolean;
  loaded: boolean;
  load(): Promise<void>;
  loadMore(): Promise<void>;
  /** 첫 페이지를 다시 받아 합친다 (예약 작업이 새로 만든 대화를 반영). 새로 생긴 대화를 돌려준다 */
  refresh(): Promise<Conversation[]>;
  /** 열어 본 대화의 새 결과 표시를 끈다 (서버는 대화를 열 때 끈다) */
  markRead(id: string): void;
  upsert(conversation: Conversation): void;
  setTitle(id: string, title: string): void;
  touch(id: string): void;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  reset(): void;
}

export const useChats = create<ChatsState>((set, get) => ({
  items: [],
  nextCursor: null,
  loading: false,
  loaded: false,

  async load() {
    if (get().loading) return;
    set({ loading: true });
    try {
      const data = await api<ListResponse>('/conversations?limit=50');
      set({ items: data.items, nextCursor: data.nextCursor, loaded: true });
    } catch {
      /* 목록을 못 불러와도 채팅 자체는 계속 쓸 수 있다 */
    } finally {
      set({ loading: false });
    }
  },

  async loadMore() {
    const cursor = get().nextCursor;
    if (!cursor || get().loading) return;
    set({ loading: true });
    try {
      const data = await api<ListResponse>(`/conversations?limit=50&cursor=${encodeURIComponent(cursor)}`);
      set((s) => {
        const known = new Set(s.items.map((i) => i.id));
        return { items: [...s.items, ...data.items.filter((i) => !known.has(i.id))], nextCursor: data.nextCursor };
      });
    } catch {
      /* 무시 */
    } finally {
      set({ loading: false });
    }
  },

  async refresh() {
    if (!get().loaded || get().loading) return [];
    try {
      const data = await api<ListResponse>('/conversations?limit=50');
      const known = new Set(get().items.map((i) => i.id));
      const added = data.items.filter((i) => !known.has(i.id));
      set((s) => {
        const fresh = new Map(data.items.map((i) => [i.id, i]));
        // 첫 페이지에 있는 건 새 값으로, 그 밖(더 보기로 불러온 것)은 그대로 둔다
        const rest = s.items.filter((i) => !fresh.has(i.id));
        return { items: [...data.items, ...rest].sort(byUpdatedDesc) };
      });
      return added;
    } catch {
      return [];
    }
  },

  markRead(id) {
    if (!get().items.some((i) => i.id === id && i.unread)) return;
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, unread: false } : i)) }));
  },

  upsert(conversation) {
    set((s) => ({ items: [conversation, ...s.items.filter((i) => i.id !== conversation.id)].sort(byUpdatedDesc) }));
  },

  setTitle(id, title) {
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, title } : i)) }));
  },

  touch(id) {
    const now = new Date().toISOString();
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, updatedAt: now } : i)).sort(byUpdatedDesc) }));
  },

  async rename(id, title) {
    const data = await api<{ conversation: Conversation }>(`/conversations/${id}`, { method: 'PATCH', body: { title } });
    get().setTitle(id, data.conversation.title);
  },

  async remove(id) {
    await api(`/conversations/${id}`, { method: 'DELETE' });
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },

  reset() {
    set({ items: [], nextCursor: null, loading: false, loaded: false });
  },
}));
