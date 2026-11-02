import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorMessage } from '../lib/api';
import { selectedStyleName, useStyles } from '../store/styles';
import { StyleIcon } from './Icons';
import { Menu } from './Menu';

/** 응답 스타일 고르기 (Claude 의 "스타일 선택"). 고른 값은 계정에 저장돼 모든 대화에 적용된다. */
export function StylePicker({ placement = 'up' }: { placement?: 'up' | 'down' }) {
  const { presets, custom, selected, loaded, load, select } = useStyles();
  const name = useStyles(selectedStyleName);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) load().catch(() => {});
  }, [loaded, load]);

  if (!loaded) return null;
  const isDefault = selected === 'default';

  const choose = (id: string) => {
    setError(null);
    select(id).catch((err) => setError(errorMessage(err)));
  };

  return (
    <div className="flex items-center gap-2">
      <Menu
        placement={placement}
        triggerLabel={`응답 스타일: ${name}`}
        title="응답 스타일"
        heading="응답 스타일"
        trigger={
          <>
            <StyleIcon size={16} className={isDefault ? '' : 'text-clay-500'} />
            {/* 기본 스타일이면 아이콘만, 다른 스타일이면 이름도 보여준다 (Claude 방식) */}
            {!isDefault && <span className="max-w-[8rem] truncate">{name}</span>}
          </>
        }
        groups={[
          {
            items: presets.map((p) => ({
              key: p.id,
              label: p.name,
              description: p.description,
              selected: p.id === selected,
              onSelect: () => choose(p.id),
            })),
          },
          ...(custom.length
            ? [
                {
                  label: '내 스타일',
                  items: custom.map((c) => ({
                    key: c.id,
                    label: c.name,
                    selected: c.id === selected,
                    onSelect: () => choose(c.id),
                  })),
                },
              ]
            : []),
        ]}
        footer={
          <button
            type="button"
            onClick={() => navigate('/settings#styles')}
            className="w-full px-3.5 py-2 text-left text-sm text-sand-600 transition-colors hover:bg-sand-100 dark:text-sand-300 dark:hover:bg-sand-700/60"
          >
            스타일 만들기·편집
          </button>
        }
      />
      {error && (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
