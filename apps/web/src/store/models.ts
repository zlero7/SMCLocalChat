import { create } from 'zustand';
import type { ModelOption } from '../lib/types';

const KEY = 'model';

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

interface ModelStore {
  models: ModelOption[];
  /** 서버가 정한 기본 모델 */
  defaultModel: string | null;
  /** 사용자가 고른 모델 (브라우저에 기억). 목록에 없으면 기본 모델을 쓴다 */
  selected: string | null;
  setOptions(models: ModelOption[], defaultModel: string): void;
  select(id: string): void;
}

export const useModels = create<ModelStore>((set) => ({
  models: [],
  defaultModel: null,
  selected: read(),
  setOptions(models, defaultModel) {
    set({ models, defaultModel });
  },
  select(id) {
    try {
      localStorage.setItem(KEY, id);
    } catch {}
    set({ selected: id });
  },
}));

/** 지금 메시지를 보낼 때 쓸 모델 id (목록을 아직 못 받았으면 undefined → 서버 기본 모델) */
export function currentModel(s: Pick<ModelStore, 'models' | 'defaultModel' | 'selected'>): string | undefined {
  if (s.selected && s.models.some((m) => m.id === s.selected)) return s.selected;
  return s.defaultModel ?? undefined;
}

export function modelLabel(models: ModelOption[], id: string | null | undefined): string | null {
  if (!id) return null;
  return models.find((m) => m.id === id)?.label ?? id;
}
