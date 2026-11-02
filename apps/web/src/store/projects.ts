import { create } from 'zustand';
import { api } from '../lib/api';
import type { Project } from '../lib/types';

interface ProjectsStore {
  items: Project[];
  max: number;
  loaded: boolean;
  load(): Promise<void>;
  /** 이름 등을 바꾼 프로젝트를 목록에 반영 */
  upsert(project: Project): void;
  remove(id: string): void;
  reset(): void;
}

/** 내 프로젝트 목록 (사이드바·대화 화면에서 이름을 보여 주고, 대화를 옮길 때 쓴다) */
export const useProjects = create<ProjectsStore>((set) => ({
  items: [],
  max: 20,
  loaded: false,
  async load() {
    try {
      const data = await api<{ items: Project[]; max: number }>('/projects');
      set({ items: data.items, max: data.max, loaded: true });
    } catch {
      /* 목록을 못 불러와도 대화는 쓸 수 있다 */
    }
  },
  upsert(project) {
    set((s) => ({
      items: s.items.some((p) => p.id === project.id)
        ? s.items.map((p) => (p.id === project.id ? { ...p, ...project } : p))
        : [project, ...s.items],
    }));
  },
  remove(id) {
    set((s) => ({ items: s.items.filter((p) => p.id !== id) }));
  },
  reset() {
    set({ items: [], loaded: false });
  },
}));
