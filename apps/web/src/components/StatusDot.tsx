import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ServerStatus } from '../lib/types';
import { useModels } from '../store/models';
import { useWebSearch } from '../store/webSearch';

/** 모델 서버 상태 (15초마다 확인): 정상 / 대기 N명 / 오프라인 */
export function StatusDot() {
  const [status, setStatus] = useState<ServerStatus | 'unreachable' | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const s = await api<ServerStatus>('/status');
        if (stopped) return;
        setStatus(s);
        useModels.getState().setOptions(s.models ?? [], s.model);
        useWebSearch.getState().setAvailable(!!s.webSearch);
      } catch {
        if (!stopped) setStatus('unreachable');
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void tick();
    }, 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  let color = 'bg-sand-400';
  let text = '확인 중';
  let title = '';
  if (status === 'unreachable') {
    color = 'bg-red-500';
    text = '서버 연결 안 됨';
  } else if (status) {
    title = `기본 모델: ${status.model}`;
    if (!status.online) {
      color = 'bg-red-500';
      text = '모델 오프라인';
    } else if (status.waiting > 0) {
      color = 'bg-amber-500';
      text = `대기 ${status.waiting}명`;
    } else {
      color = 'bg-emerald-500';
      text = status.active > 0 ? '답변 생성 중' : '모델 정상';
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs text-sand-500 dark:text-sand-400" title={title}>
      <span className={`size-2 rounded-full ${color}`} aria-hidden="true" />
      <span className="hidden sm:inline">{text}</span>
      <span className="sr-only sm:hidden">{text}</span>
    </div>
  );
}
