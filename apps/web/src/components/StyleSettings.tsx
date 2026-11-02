import { useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '../lib/api';
import type { CustomStyle } from '../lib/types';
import { useStyles } from '../store/styles';
import { CheckIcon, PencilIcon, PlusIcon, TrashIcon } from './Icons';
import { ErrorBox, PrimaryButton, SecondaryButton, inputClass } from './ui';

interface Draft {
  /** 고치는 중인 내 스타일 id (새로 만들면 없음) */
  id?: string;
  name: string;
  instruction: string;
}

function StyleEditor({ draft, onDone }: { draft: Draft; onDone(): void }) {
  const { presets, create, update, select } = useStyles();
  const [name, setName] = useState(draft.name);
  const [instruction, setInstruction] = useState(draft.instruction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (draft.id) {
        await update(draft.id, { name, instruction });
      } else {
        const created = await create({ name, instruction });
        await select(created.id); // 새로 만든 스타일은 바로 쓴다
      }
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-xl border border-clay-300 bg-clay-50/50 p-4 dark:border-clay-800 dark:bg-clay-950/30"
    >
      <p className="text-sm font-medium">{draft.id ? '스타일 고치기' : '새 스타일'}</p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={30}
        required
        placeholder="스타일 이름 (예: 친구처럼 반말로)"
        aria-label="스타일 이름"
        className={inputClass}
      />
      {!draft.id && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-sand-500">
          <span>기본 스타일에서 시작:</span>
          {presets
            .filter((p) => p.instruction)
            .map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setInstruction(p.instruction)}
                className="rounded-md border border-sand-300 bg-white px-2 py-0.5 text-sand-600 hover:bg-sand-100 dark:border-sand-600 dark:bg-sand-800 dark:text-sand-300 dark:hover:bg-sand-700"
              >
                {p.name}
              </button>
            ))}
        </div>
      )}
      <div>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          maxLength={2000}
          required
          rows={6}
          placeholder="AI 가 어떤 말투와 형식으로 답할지 적어 주세요. 예: 친구처럼 반말로 짧게 답하고, 어려운 말은 쉬운 비유로 설명해 줘."
          aria-label="스타일 지침"
          className={`${inputClass} resize-y`}
        />
        <p className="mt-1 text-right text-xs text-sand-500">{instruction.length} / 2000</p>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="flex gap-2">
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? '저장 중…' : draft.id ? '저장' : '만들고 사용하기'}
        </PrimaryButton>
        <SecondaryButton type="button" onClick={onDone} disabled={busy}>
          취소
        </SecondaryButton>
      </div>
    </form>
  );
}

function StyleCard({
  name,
  description,
  selected,
  onSelect,
  actions,
}: {
  name: string;
  description: string;
  selected: boolean;
  onSelect(): void;
  actions?: ReactNode;
}) {
  return (
    <div
      className={`group relative rounded-xl border transition-colors ${
        selected
          ? 'border-clay-500 bg-clay-50/60 ring-1 ring-clay-500 dark:bg-clay-950/30'
          : 'border-sand-200 bg-white hover:border-sand-300 dark:border-sand-700 dark:bg-sand-800 dark:hover:border-sand-600'
      }`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="block w-full p-3.5 pr-10 text-left"
      >
        <span className="block text-sm font-medium">{name}</span>
        <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-sand-500 dark:text-sand-400">
          {description}
        </span>
      </button>
      {selected && <CheckIcon size={16} className="absolute top-3.5 right-3.5 text-clay-500" />}
      {actions && <div className="flex justify-end gap-0.5 px-2 pb-2 -mt-1">{actions}</div>}
    </div>
  );
}

const iconButton =
  'rounded-md p-1.5 text-sand-500 hover:bg-sand-200/70 hover:text-sand-900 dark:hover:bg-sand-700 dark:hover:text-sand-50';

/** 설정 화면의 "응답 스타일" 카드 내용 */
export function StyleSettings() {
  const { presets, custom, selected, maxCustom, select, remove } = useStyles();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = (id: string) => {
    setError(null);
    select(id).catch((err) => setError(errorMessage(err)));
  };

  const onDelete = async (style: CustomStyle) => {
    if (!window.confirm(`"${style.name}" 스타일을 지울까요?`)) return;
    try {
      await remove(style.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2.5 sm:grid-cols-2" role="radiogroup" aria-label="응답 스타일">
        {presets.map((p) => (
          <StyleCard
            key={p.id}
            name={p.name}
            description={p.description}
            selected={p.id === selected}
            onSelect={() => choose(p.id)}
            actions={
              p.instruction ? (
                <button
                  type="button"
                  onClick={() => setEditing({ name: `${p.name} (내 버전)`, instruction: p.instruction })}
                  className="rounded-md px-1.5 py-0.5 text-xs text-sand-500 opacity-100 hover:bg-sand-200/70 hover:text-sand-900 md:opacity-0 md:group-hover:opacity-100 dark:hover:bg-sand-700 dark:hover:text-sand-50"
                >
                  복사해서 고치기
                </button>
              ) : undefined
            }
          />
        ))}
        {custom.map((c) => (
          <StyleCard
            key={c.id}
            name={c.name}
            description={c.instruction}
            selected={c.id === selected}
            onSelect={() => choose(c.id)}
            actions={
              <>
                <button
                  type="button"
                  onClick={() => setEditing({ id: c.id, name: c.name, instruction: c.instruction })}
                  aria-label={`${c.name} 고치기`}
                  title="고치기"
                  className={iconButton}
                >
                  <PencilIcon size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => void onDelete(c)}
                  aria-label={`${c.name} 지우기`}
                  title="지우기"
                  className={iconButton}
                >
                  <TrashIcon size={14} />
                </button>
              </>
            }
          />
        ))}
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {editing ? (
        <StyleEditor key={editing.id ?? editing.name} draft={editing} onDone={() => setEditing(null)} />
      ) : (
        custom.length < maxCustom && (
          <button
            type="button"
            onClick={() => setEditing({ name: '', instruction: '' })}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-clay-600 hover:bg-clay-50 dark:text-clay-400 dark:hover:bg-clay-950/40"
          >
            <PlusIcon size={15} /> 내 스타일 만들기
          </button>
        )
      )}
    </div>
  );
}
