import { Link } from 'react-router-dom';
import { useMemoryNotice } from '../store/memoryNotice';
import { BulbIcon } from './Icons';

/** 마지막 답변 아래: 이번 대화에서 새로 기억한 것 (설정에서 보거나 지울 수 있다고 알려 준다) */
export function MemoryNotice({ convId }: { convId: string }) {
  const notice = useMemoryNotice();
  if (notice.convId !== convId || notice.items.length === 0) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-xl border border-sand-200 bg-sand-50 px-3 py-2 text-xs text-sand-600 dark:border-sand-700 dark:bg-sand-900 dark:text-sand-300"
    >
      <BulbIcon size={14} className="mt-0.5 shrink-0 text-amber-500" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">기억했어요: </span>
        {notice.items.map((m) => m.content).join(' · ')}
      </span>
      <Link to="/settings#memory" className="shrink-0 underline-offset-2 hover:underline">
        관리
      </Link>
      <button type="button" onClick={notice.clear} aria-label="닫기" className="shrink-0 hover:text-sand-900 dark:hover:text-sand-50">
        ✕
      </button>
    </div>
  );
}
