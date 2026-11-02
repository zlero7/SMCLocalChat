import { create } from 'zustand';
import { api } from '../lib/api';
import type { CustomStyle, StylePreset, User } from '../lib/types';
import { useAuth } from './auth';

interface StylesResponse {
  presets: StylePreset[];
  custom: CustomStyle[];
  selected: string;
  maxCustom: number;
}

interface StyleInput {
  name: string;
  instruction: string;
}

interface StylesStore {
  presets: StylePreset[];
  custom: CustomStyle[];
  selected: string;
  maxCustom: number;
  loaded: boolean;
  load(): Promise<void>;
  /** 모든 대화에 쓸 스타일을 고른다 (서버에 저장) */
  select(id: string): Promise<void>;
  create(input: StyleInput): Promise<CustomStyle>;
  update(id: string, input: StyleInput): Promise<void>;
  remove(id: string): Promise<void>;
  reset(): void;
}

const initial = { presets: [], custom: [], selected: 'default', maxCustom: 10, loaded: false };

export const useStyles = create<StylesStore>((set, get) => ({
  ...initial,

  async load() {
    const data = await api<StylesResponse>('/styles');
    set({ ...data, loaded: true });
  },

  async select(id) {
    const prev = get().selected;
    set({ selected: id }); // 바로 반영하고, 실패하면 되돌린다
    try {
      const { user } = await api<{ user: User }>('/me', { method: 'PATCH', body: { styleId: id } });
      useAuth.getState().setUser(user);
    } catch (err) {
      set({ selected: prev });
      throw err;
    }
  },

  async create(input) {
    const { style } = await api<{ style: CustomStyle }>('/styles', { body: input });
    set((s) => ({ custom: [...s.custom, style] }));
    return style;
  },

  async update(id, input) {
    const { style } = await api<{ style: CustomStyle }>(`/styles/${id}`, { method: 'PATCH', body: input });
    set((s) => ({ custom: s.custom.map((c) => (c.id === id ? style : c)) }));
  },

  async remove(id) {
    await api(`/styles/${id}`, { method: 'DELETE' });
    // 쓰고 있던 스타일을 지우면 서버가 기본 스타일로 돌린다
    set((s) => ({ custom: s.custom.filter((c) => c.id !== id), selected: s.selected === id ? 'default' : s.selected }));
  },

  reset() {
    set(initial);
  },
}));

/** 지금 고른 스타일의 이름 (목록을 못 불러왔으면 '기본') */
export function selectedStyleName(s: Pick<StylesStore, 'presets' | 'custom' | 'selected'>): string {
  return s.presets.find((p) => p.id === s.selected)?.name ?? s.custom.find((c) => c.id === s.selected)?.name ?? '기본';
}
