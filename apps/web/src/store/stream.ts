import { create } from 'zustand';
import { ApiError, api } from '../lib/api';
import { buildPreview, runLocalTool, type LocalFolder, type ToolRunResult } from '../lib/localFolder';
import { approvalFor, usePermission, type PermissionMode } from './permission';
import { streamMessage, type SendBody } from '../lib/sse';
import type { MessageStatus, ToolExec, ToolRequest, ToolStep } from '../lib/types';
import { useChats } from './chats';
import { useEffort } from './effort';
import { gmailActive, useGoogle } from './google';
import { useMemoryNotice } from './memoryNotice';
import { useUsage } from './usage';
import { useWebSearch, webSearchActive } from './webSearch';

/** 답변을 시작할 때 서버에 보낼 것 (폴더·웹 검색은 start 가 채운다) */
export type StartRequest = Pick<SendBody, 'content' | 'model' | 'regenerate' | 'editMessageId' | 'attachmentIds'>;

export type Phase =
  | 'connecting'
  | 'queued'
  | 'loading'
  /** 긴 대화의 앞부분을 요약하는 중 */
  | 'compacting'
  | 'thinking'
  | 'answering'
  | 'stopping'
  | 'finished';

export interface StreamState {
  token: number;
  convId: string;
  content: string;
  reasoning: string;
  phase: Phase;
  queuePosition: number;
  status?: MessageStatus;
  error?: string;
  /** 서버가 요청 자체를 거절함(400/409/429 등) → 보낸 메시지가 저장되지 않았다 */
  rejected?: boolean;
  /** 이번 답변에서 AI 가 한 파일 작업 (끝난 것) */
  tools: ToolStep[];
  /** 허용을 기다리는 파일 작업 */
  pending: ToolRequest | null;
  /** 허용을 눌러서 파일 작업을 하는 중 */
  deciding: boolean;
}

interface StreamStore {
  stream: StreamState | null;
  /**
   * 답변 만들기 시작. request: 보낼 글과 다시 만들기·고치기·첨부 같은 선택 사항.
   * folder: 이 대화에서 AI 가 다룰 내 컴퓨터 폴더 (없으면 일반 대화)
   */
  start(convId: string, request: StartRequest, folder?: LocalFolder | null): void;
  stop(): Promise<void>;
  /** 허용을 기다리는 파일 작업에 답한다 */
  decide(approve: boolean, switchMode?: PermissionMode): Promise<void>;
  clear(): void;
  reset(): void;
}

let tokenSeq = 0;
let activeCtrl: AbortController | null = null;
// 토큰이 빠르게 들어와도 화면 갱신은 프레임당 1번만 하도록 모아서 반영한다
let buffer = { content: '', reasoning: '' };
let raf = 0;
// 허용/거절 카드가 떠 있을 때 사용자의 답을 기다리는 함수
let resolveDecision: ((approve: boolean) => void) | null = null;

const cancelDecision = () => {
  resolveDecision?.(false);
  resolveDecision = null;
};

/** 도구 결과를 서버에 보낸다 (서버가 모델에게 돌려주고 tool_result 로 화면에 알려 준다) */
const postResult = (convId: string, callId: string, r: ToolRunResult | { status: 'denied'; result: string; summary: string }) =>
  api(`/conversations/${convId}/tool-result`, { body: { callId, ...r } }).catch(() => {
    /* 이미 중단됐거나 시간이 지났으면 서버가 404 를 준다. 무시 */
  });

/**
 * 답변 스트림 상태를 화면(컴포넌트)과 분리해서 들고 있다.
 * 그래서 답변을 만드는 동안 다른 대화로 이동했다 돌아와도 스트림이 끊기지 않는다.
 * (서버는 사용자당 동시에 1건만 생성한다)
 */
export const useStream = create<StreamStore>((set, get) => {
  const patch = (token: number, fn: (s: StreamState) => Partial<StreamState>) =>
    set((st) => (st.stream && st.stream.token === token ? { stream: { ...st.stream, ...fn(st.stream) } } : st));

  const flush = (token: number) => {
    raf = 0;
    if (!buffer.content && !buffer.reasoning) return;
    const { content, reasoning } = buffer;
    buffer = { content: '', reasoning: '' };
    patch(token, (s) => ({
      content: s.content + content,
      reasoning: s.reasoning + reasoning,
      phase: s.phase === 'stopping' ? 'stopping' : content ? 'answering' : 'thinking',
    }));
  };
  const schedule = (token: number) => {
    if (!raf) raf = requestAnimationFrame(() => flush(token));
  };
  const flushNow = (token: number) => {
    if (raf) cancelAnimationFrame(raf);
    flush(token);
  };

  return {
    stream: null,

    start(convId, request, folder) {
      const token = ++tokenSeq;
      useMemoryNotice.getState().clear(); // 지난 답변의 "기억했어요" 안내는 새 질문을 보내면 지운다
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      buffer = { content: '', reasoning: '' };
      cancelDecision();
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      set({
        stream: {
          token,
          convId,
          content: '',
          reasoning: '',
          phase: 'connecting',
          queuePosition: 0,
          tools: [],
          pending: null,
          deciding: false,
        },
      });
      useChats.getState().touch(convId);

      /** AI 의 파일 작업 하나를 내 컴퓨터 폴더에서 실행한다. 쓰기 작업은 먼저 허용을 받는다 */
      const execTool = async (req: ToolExec) => {
        if (!folder) {
          return postResult(convId, req.id, { status: 'error', result: '오류: 이 브라우저에서 연 폴더가 없어요', summary: '열린 폴더 없음' });
        }
        if (req.needsApproval) {
          const preview = await buildPreview(folder, req.name, req.args);
          if ('status' in preview) return postResult(convId, req.id, preview); // 미리보기도 못 만들면(없는 파일 등) 오류로
          const verdict = approvalFor(usePermission.getState().mode, preview);
          if (verdict === 'deny') {
            return postResult(convId, req.id, {
              status: 'denied',
              result: '권한이 "읽기만"이라 파일을 바꿀 수 없습니다. 읽기 전용으로 할 수 있는 일만 하거나, 사용자에게 권한 단계를 바꿔 달라고 안내하세요.',
              summary: '읽기만 모드라 막음',
            });
          }
          if (verdict === 'ask') {
            const request: ToolRequest = { id: req.id, name: req.name, args: req.args, preview };
            patch(token, () => ({ pending: request, deciding: false }));
            const approved = await new Promise<boolean>((resolve) => {
              resolveDecision = resolve;
            });
            if (!approved) {
              patch(token, (s) => (s.pending?.id === req.id ? { pending: null } : {}));
              return postResult(convId, req.id, { status: 'denied', result: '사용자가 이 작업을 거절했습니다.', summary: '거절함' });
            }
            patch(token, () => ({ deciding: true }));
          }
        }
        return postResult(convId, req.id, await runLocalTool(folder, req.name, req.args));
      };

      streamMessage(
        convId,
        {
          ...request,
          localFolder: folder?.name,
          webSearch: webSearchActive(useWebSearch.getState()) || undefined,
          effort: useEffort.getState().effort,
          gmail: gmailActive(useGoogle.getState()) || undefined,
        },
        {
          onQueue: (position) =>
            patch(token, (s) => ({ phase: s.phase === 'stopping' ? 'stopping' : 'queued', queuePosition: position })),
          onStart: () => patch(token, (s) => ({ phase: s.phase === 'stopping' ? 'stopping' : 'thinking', queuePosition: 0 })),
          // 이미 글자가 오기 시작했으면 무시한다 (첫 글자가 오면 flush 가 thinking/answering 으로 바꾼다)
          onLoading: () =>
            patch(token, (s) =>
              s.phase === 'thinking' && !s.content && !s.reasoning && !buffer.content && !buffer.reasoning
                ? { phase: 'loading' }
                : {},
            ),
          onCompacting: () => patch(token, (s) => (s.phase === 'stopping' ? {} : { phase: 'compacting' })),
          onReasoning: (t) => {
            buffer.reasoning += t;
            schedule(token);
          },
          onDelta: (t) => {
            buffer.content += t;
            schedule(token);
          },
          onToolExec: (req) => {
            flushNow(token);
            void execTool(req);
          },
          onToolStart: (step) => {
            flushNow(token);
            patch(token, (s) => ({ tools: [...s.tools, { ...step, status: 'running', summary: '' }] }));
          },
          onToolResult: (step) => {
            flushNow(token);
            patch(token, (s) => ({
              // 진행 중으로 먼저 보여 준 단계(웹 도구)는 결과로 바꾼다
              tools: s.tools.some((t) => t.id === step.id) ? s.tools.map((t) => (t.id === step.id ? step : t)) : [...s.tools, step],
              pending: s.pending?.id === step.id ? null : s.pending,
              deciding: false,
            }));
          },
          onTitle: (title) => useChats.getState().setTitle(convId, title),
          onMemory: (items) => {
            if (items.length) useMemoryNotice.getState().show(convId, items);
          },
          onError: (message) => patch(token, () => ({ error: message })),
          onDone: ({ status }) => {
            flushNow(token);
            patch(token, () => ({ phase: 'finished', status }));
            void useUsage.getState().refresh(); // 서버는 done 을 보내기 전에 사용량을 기록한다
          },
        },
        ctrl.signal,
      )
        .catch((err: unknown) => {
          flushNow(token);
          void useUsage.getState().refresh(); // 사용량 초과로 거절됐을 수도 있다
          if (ctrl.signal.aborted) {
            patch(token, () => ({ phase: 'finished', status: 'stopped' }));
            return;
          }
          patch(token, (s) =>
            s.phase === 'finished'
              ? {}
              : {
                  phase: 'finished',
                  status: 'error',
                  error: err instanceof Error ? err.message : '메시지를 보내지 못했어요',
                  rejected: err instanceof ApiError,
                },
          );
        })
        .finally(() => {
          if (activeCtrl === ctrl) activeCtrl = null;
          cancelDecision();
          patch(token, () => ({ pending: null, deciding: false }));
        });
    },

    async stop() {
      const s = get().stream;
      if (!s || s.phase === 'finished' || s.phase === 'stopping') return;
      patch(s.token, () => ({ phase: 'stopping' }));
      try {
        const res = await api<{ stopped: boolean }>(`/conversations/${s.convId}/stop`, { method: 'POST' });
        if (!res.stopped) activeCtrl?.abort(); // 서버가 모르는 요청이면 연결을 직접 끊는다
      } catch {
        activeCtrl?.abort();
      }
    },

    async decide(approve, switchMode) {
      const s = get().stream;
      if (!s?.pending || s.deciding || !resolveDecision) return;
      if (approve && switchMode) usePermission.getState().select(switchMode); // "허용하고 앞으로 묻지 않기"
      const resolve = resolveDecision;
      resolveDecision = null;
      resolve(approve);
    },

    clear() {
      set({ stream: null });
    },

    reset() {
      cancelDecision();
      activeCtrl?.abort();
      activeCtrl = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      buffer = { content: '', reasoning: '' };
      set({ stream: null });
    },
  };
});
