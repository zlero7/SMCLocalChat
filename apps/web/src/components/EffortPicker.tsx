import { EFFORT_OPTIONS, useEffort } from '../store/effort';
import { ChevronDownIcon } from './Icons';
import { Menu } from './Menu';

/** 노력(생각 깊이) 고르기. 다음 메시지부터 적용되고, 고른 값은 브라우저에 기억된다. */
export function EffortPicker({ placement = 'up' }: { placement?: 'up' | 'down' }) {
  const effort = useEffort((s) => s.effort);
  const select = useEffort((s) => s.select);
  const current = EFFORT_OPTIONS.find((o) => o.id === effort) ?? EFFORT_OPTIONS[1]!;

  return (
    <Menu
      placement={placement}
      align="right"
      triggerLabel={`노력: ${current.label}`}
      title="AI 가 답하기 전에 얼마나 생각할지"
      heading="노력 — 깊게 생각할수록 답이 좋아지지만 느려져요"
      trigger={
        <>
          <span className="text-sand-400 dark:text-sand-500">노력</span>
          <span>{current.label}</span>
          <ChevronDownIcon size={14} className="shrink-0 opacity-70" />
        </>
      }
      groups={[
        {
          items: EFFORT_OPTIONS.map((o) => ({
            key: o.id,
            label: o.label,
            description: o.description,
            selected: o.id === effort,
            onSelect: () => select(o.id),
          })),
        },
      ]}
    />
  );
}
