import { PERMISSION_OPTIONS, usePermission } from '../store/permission';
import { ChevronDownIcon } from './Icons';
import { Menu } from './Menu';

/** 폴더를 열었을 때, AI 가 파일을 바꾸기 전에 어디까지 물어볼지 고르기 (이 브라우저에 기억) */
export function PermissionPicker({ placement = 'up' }: { placement?: 'up' | 'down' }) {
  const mode = usePermission((s) => s.mode);
  const select = usePermission((s) => s.select);
  const current = PERMISSION_OPTIONS.find((o) => o.id === mode) ?? PERMISSION_OPTIONS[1]!;

  return (
    <Menu
      placement={placement}
      triggerLabel={`권한: ${current.label}`}
      title="AI 가 파일을 바꾸기 전에 어디까지 물어볼지"
      heading="권한 — 자동일수록 편하지만, 믿는 폴더에서만 쓰세요"
      trigger={
        <>
          <span className="text-sand-400 dark:text-sand-500">권한</span>
          <span>{current.label}</span>
          <ChevronDownIcon size={14} className="shrink-0 opacity-70" />
        </>
      }
      groups={[
        {
          items: PERMISSION_OPTIONS.map((o) => ({
            key: o.id,
            label: o.label,
            description: o.description,
            selected: o.id === mode,
            onSelect: () => select(o.id),
          })),
        },
      ]}
    />
  );
}
