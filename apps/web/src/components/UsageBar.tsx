import type { Usage } from '../lib/types';
import { formatResetAt, formatTokens, usageRatio } from '../store/usage';

/** 5시간 사용량 막대 + 설명 (설정 화면, 관리자 화면에서 같이 쓴다) */
export function UsageBar({ usage, compact = false }: { usage: Usage; compact?: boolean }) {
  const ratio = usageRatio(usage);
  const percent = Math.round(ratio * 100);
  const color = ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-clay-500';

  let note: string;
  if (usage.limit === 0) note = '사용이 막혀 있어요';
  else if (!usage.resetAt) note = `첫 메시지부터 ${usage.windowHours}시간 동안 집계돼요`;
  else note = `${formatResetAt(usage.resetAt)}에 초기화`;

  return (
    <div>
      <div
        className={`overflow-hidden rounded-full bg-sand-200 dark:bg-sand-700 ${compact ? 'h-1.5' : 'h-2'}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="5시간 사용량"
      >
        <div className={`h-full rounded-full transition-[width] ${color}`} style={{ width: `${percent}%` }} />
      </div>
      <div className={`mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 ${compact ? 'text-xs' : 'text-sm'}`}>
        <span className="tabular-nums text-sand-700 dark:text-sand-200">
          {formatTokens(usage.used)} / {formatTokens(usage.limit)} 토큰 <span className="text-sand-500">({percent}%)</span>
        </span>
        <span className="text-xs text-sand-500">{note}</span>
      </div>
    </div>
  );
}
