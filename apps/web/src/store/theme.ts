import { create } from 'zustand';

export type Theme = 'system' | 'light' | 'dark';

const media = window.matchMedia('(prefers-color-scheme: dark)');

function read(): Theme {
  try {
    const v = localStorage.getItem('theme');
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {}
  return 'system';
}

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
}

export const useTheme = create<{ theme: Theme; setTheme(t: Theme): void; cycle(): void }>((set, get) => ({
  theme: read(),
  setTheme(theme) {
    try {
      localStorage.setItem('theme', theme);
    } catch {}
    apply(theme);
    set({ theme });
  },
  cycle() {
    const order: Theme[] = ['system', 'light', 'dark'];
    get().setTheme(order[(order.indexOf(get().theme) + 1) % order.length]!);
  },
}));

apply(useTheme.getState().theme);
media.addEventListener('change', () => apply(useTheme.getState().theme));
