import { currentModel, useModels } from '../store/models';
import { ChevronDownIcon } from './Icons';
import { Menu } from './Menu';

/** "Qwen 3.6 35B (똑똑함·느림)" → 이름 "Qwen 3.6 35B", 설명 "똑똑함·느림" */
function splitLabel(label: string): { name: string; description?: string } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(label);
  return m ? { name: m[1]!, description: m[2] } : { name: label };
}

/** 다음 메시지에 쓸 모델 고르기. 고른 값은 브라우저에 기억된다. */
export function ModelPicker({ placement = 'up' }: { placement?: 'up' | 'down' }) {
  const models = useModels((s) => s.models);
  const value = useModels(currentModel);
  const select = useModels((s) => s.select);

  if (models.length === 0) return null;
  const current = splitLabel(models.find((m) => m.id === value)?.label ?? value ?? '');
  if (models.length === 1) {
    return <span className="px-2 text-sm text-sand-500 dark:text-sand-400">{current.name}</span>;
  }

  return (
    <Menu
      placement={placement}
      align="right"
      triggerLabel={`모델 선택: ${current.name}`}
      title="다음 메시지에 쓸 모델"
      heading="모델"
      trigger={
        <>
          <span className="max-w-[9rem] truncate sm:max-w-none">{current.name}</span>
          <ChevronDownIcon size={14} className="shrink-0 opacity-70" />
        </>
      }
      groups={[
        {
          items: models.map((m) => {
            const { name, description } = splitLabel(m.label);
            return { key: m.id, label: name, description, selected: m.id === value, onSelect: () => select(m.id) };
          }),
        },
      ]}
    />
  );
}
