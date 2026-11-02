import { useState } from 'react';
import { localFolderUnsupportedReason, pickLocalFolder, type LocalFolder } from '../lib/localFolder';
import { FolderIcon } from './Icons';
import { Menu } from './Menu';

/**
 * 이 대화에서 AI 가 다룰 내 컴퓨터 폴더 고르기 (Claude Code 처럼).
 * 고르면 브라우저가 그 폴더 권한을 묻고, AI 는 그 폴더 안의 파일만 다룬다. null 이면 일반 대화.
 */
export function FolderPicker({
  value,
  onChange,
  disabled,
  placement = 'up',
}: {
  value: LocalFolder | null;
  onChange(folder: LocalFolder | null): void;
  disabled?: boolean;
  placement?: 'up' | 'down';
}) {
  const [error, setError] = useState<string | null>(null);
  const unsupported = localFolderUnsupportedReason();

  const open = () => {
    setError(null);
    if (unsupported) return setError(unsupported);
    // 메뉴 항목을 누른 바로 그 순간에 불러야 브라우저가 폴더 창을 띄워 준다
    pickLocalFolder()
      .then((f) => {
        if (f) return onChange(f);
        // 취소했을 때도 오지만, 폴더 권한을 막는 브라우저(Claude 앱 안 브라우저 등)도 똑같이 "취소"로 돌려준다
        setError('폴더가 열리지 않았어요. 골랐는데도 이렇다면 이 브라우저가 폴더 권한을 막은 거예요 — 크롬·엣지에서 열어 주세요.');
      })
      .catch((err) => setError(`폴더를 열지 못했어요 (${(err as Error).message})`));
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Menu
        placement={placement}
        triggerLabel={value ? `작업 폴더: ${value.name}` : '내 컴퓨터 폴더 열기'}
        title={disabled ? '답변이 끝난 뒤에 바꿀 수 있어요' : 'AI 가 다룰 내 컴퓨터 폴더'}
        heading="내 컴퓨터 폴더 — AI 가 이 폴더 안의 파일을 읽고, 허용하면 고쳐요"
        triggerClassName={disabled ? 'pointer-events-none opacity-50' : ''}
        trigger={
          <>
            <FolderIcon size={16} className={value ? 'text-clay-500' : ''} />
            {value && <span className="max-w-[9rem] truncate">{value.name}</span>}
          </>
        }
        groups={[
          {
            items: [
              {
                key: 'none',
                label: '폴더 없이 대화',
                description: '파일을 다루지 않는 일반 대화',
                selected: !value,
                onSelect: () => onChange(null),
              },
              ...(value
                ? [{ key: 'current', label: value.name, description: '지금 연 폴더', selected: true, onSelect: () => {} }]
                : []),
              {
                key: 'open',
                label: value ? '다른 폴더 열기…' : '내 컴퓨터 폴더 열기…',
                description: unsupported ?? '폴더를 고르면 브라우저가 읽기·쓰기 권한을 물어요',
                onSelect: open,
              },
            ],
          },
        ]}
      />
      {error && (
        <span role="alert" className="truncate text-xs text-red-600 dark:text-red-400" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
