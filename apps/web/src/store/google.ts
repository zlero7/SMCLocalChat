import { create } from 'zustand';
import { api } from '../lib/api';

export interface GoogleStatus {
  /** 사이트에 구글 로그인이 설정돼 있는지 */
  configured: boolean;
  /** 이 계정에 구글 로그인이 이어져 있는지 */
  linked: boolean;
  /** 비밀번호가 있는지 (구글로만 가입했으면 없음) */
  hasPassword: boolean;
  /** 연결된 Gmail (없으면 null) */
  gmail: { email: string; connectedAt: string } | null;
}

const KEY = 'gmail';
const readToggle = () => {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
};

interface GoogleStore {
  status: GoogleStatus | null;
  /** 입력창의 Gmail 켜기 (브라우저에 기억) */
  gmailOn: boolean;
  load(): Promise<void>;
  toggleGmail(): void;
}

export const useGoogle = create<GoogleStore>((set, get) => ({
  status: null,
  gmailOn: readToggle(),
  async load() {
    try {
      set({ status: await api<GoogleStatus>('/google/status') });
    } catch {
      /* 구글 기능만 안 보일 뿐 */
    }
  },
  toggleGmail() {
    const gmailOn = !get().gmailOn;
    try {
      localStorage.setItem(KEY, gmailOn ? 'on' : 'off');
    } catch {}
    set({ gmailOn });
  },
}));

/** 이번 메시지에 Gmail 을 쓸지 (연결돼 있고 켜 두었을 때) */
export const gmailActive = (s: Pick<GoogleStore, 'status' | 'gmailOn'>) => !!s.status?.gmail && s.gmailOn;
