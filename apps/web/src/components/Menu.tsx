import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CheckIcon } from './Icons';

export interface MenuItem {
  key: string;
  label: string;
  description?: string;
  selected?: boolean;
  onSelect(): void;
}

interface Props {
  /** 메뉴를 여는 버튼 안의 내용 */
  trigger: ReactNode;
  triggerLabel: string;
  title?: string;
  /** 메뉴 위 작은 제목 */
  heading?: string;
  groups: { label?: string; items: MenuItem[] }[];
  /** 메뉴 맨 아래 (예: "스타일 관리") */
  footer?: ReactNode;
  /** 입력창이 화면 아래에 있으면 위로, 가운데 있으면 아래로 연다 */
  placement?: 'up' | 'down';
  align?: 'left' | 'right';
  triggerClassName?: string;
  /** 메뉴가 열릴 때 (목록을 새로 불러오는 데 쓴다) */
  onOpen?(): void;
}

/** 버튼을 누르면 펼쳐지는 선택 메뉴. 바깥을 누르거나 Esc 를 누르면 닫힌다. */
export function Menu({
  trigger,
  triggerLabel,
  title,
  heading,
  groups,
  footer,
  placement = 'up',
  align = 'left',
  triggerClassName = '',
  onOpen,
}: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() =>
          setOpen((o) => {
            if (!o) onOpen?.();
            return !o;
          })
        }
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={title}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-sand-600 transition-colors hover:bg-sand-100 hover:text-sand-900 dark:text-sand-300 dark:hover:bg-sand-700/60 dark:hover:text-sand-50 ${
          open ? 'bg-sand-100 text-sand-900 dark:bg-sand-700/60 dark:text-sand-50' : ''
        } ${triggerClassName}`}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className={`absolute z-50 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-sand-200 bg-white py-1.5 shadow-lg shadow-sand-900/10 dark:border-sand-700 dark:bg-sand-800 ${
            placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
          } ${align === 'left' ? 'left-0' : 'right-0'}`}
        >
          {heading && <p className="px-3.5 pt-1.5 pb-1 text-xs font-medium text-sand-500">{heading}</p>}
          <div className="max-h-[min(60vh,26rem)] overflow-y-auto">
            {groups.map((group, gi) => (
              <div key={group.label ?? gi} className={gi > 0 ? 'mt-1 border-t border-sand-100 pt-1 dark:border-sand-700' : ''}>
                {group.label && <p className="px-3.5 pt-1.5 pb-0.5 text-xs text-sand-500">{group.label}</p>}
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={!!item.selected}
                    onClick={() => {
                      setOpen(false);
                      item.onSelect();
                    }}
                    className="flex w-full items-start gap-2 px-3.5 py-2 text-left transition-colors hover:bg-sand-100 dark:hover:bg-sand-700/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-sand-900 dark:text-sand-50">{item.label}</span>
                      {item.description && (
                        <span className="mt-0.5 block text-xs leading-snug text-sand-500 dark:text-sand-400">
                          {item.description}
                        </span>
                      )}
                    </span>
                    {item.selected && <CheckIcon size={16} className="mt-0.5 shrink-0 text-clay-500" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
          {footer && (
            <div className="mt-1 border-t border-sand-100 pt-1 dark:border-sand-700" onClick={() => setOpen(false)}>
              {footer}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
