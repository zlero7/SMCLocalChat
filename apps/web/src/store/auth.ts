import { create } from 'zustand';
import { api, refreshSession, setAccessToken, setAuthLostHandler } from '../lib/api';
import type { AuthResponse, User } from '../lib/types';
import { useChats } from './chats';
import { useStream } from './stream';
import { useStyles } from './styles';
import { useUsage } from './usage';

interface RegisterInput {
  email: string;
  nickname: string;
  password: string;
  inviteCode?: string;
}

interface AuthState {
  user: User | null;
  /** 앱 시작 시 로그인 상태 확인이 끝났는지 */
  ready: boolean;
  bootstrap(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  logout(): Promise<void>;
  setUser(user: User): void;
}

function clearLocalState() {
  setAccessToken(null);
  useChats.getState().reset();
  useStream.getState().reset();
  useStyles.getState().reset();
  useUsage.getState().reset();
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: false,

  async bootstrap() {
    const user = await refreshSession();
    set({ user, ready: true });
  },

  async login(email, password) {
    const data = await api<AuthResponse>('/auth/login', { body: { email, password }, noRefresh: true });
    setAccessToken(data.accessToken);
    set({ user: data.user });
  },

  async register(input) {
    const data = await api<AuthResponse>('/auth/register', { body: input, noRefresh: true });
    setAccessToken(data.accessToken);
    set({ user: data.user });
  },

  async logout() {
    try {
      await api('/auth/logout', { method: 'POST', noRefresh: true });
    } catch {
      /* 서버에 못 닿아도 이 기기에서는 로그아웃 처리 */
    }
    clearLocalState();
    set({ user: null });
  },

  setUser(user) {
    set({ user });
  },
}));

// 토큰 갱신까지 실패하면(로그인 만료) 로그인 화면으로 보낸다
setAuthLostHandler(() => {
  clearLocalState();
  useAuth.setState({ user: null });
});
