import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import type { Memory, User } from '../lib/types';
import { useAuth } from '../store/auth';
import { TrashIcon } from './Icons';
import { ErrorBox, PrimaryButton, SecondaryButton, inputClass } from './ui';

/** 설정의 "기억" 칸: 켜고 끄기, 기억 목록 보기·지우기, 직접 적어 넣기 */
export function MemorySettings() {
  const user = useAuth((s) => s.user)!;
  const setUser = useAuth((s) => s.setUser);
  const [items, setItems] = useState<Memory[] | null>(null);
  const [max, setMax] = useState(100);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: Memory[]; max: number }>('/me/memories')
      .then((d) => {
        setItems(d.items);
        setMax(d.max);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = () =>
    run(async () => {
      const { user: updated } = await api<{ user: User }>('/me', { method: 'PATCH', body: { memoryEnabled: !user.memoryEnabled } });
      setUser(updated);
    });

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { memory } = await api<{ memory: Memory }>('/me/memories', { body: { content: draft } });
      setItems((list) => [memory, ...(list ?? [])]);
      setDraft('');
    });
  };

  const remove = (m: Memory) =>
    run(async () => {
      await api(`/me/memories/${m.id}`, { method: 'DELETE' });
      setItems((list) => list?.filter((x) => x.id !== m.id) ?? null);
    });

  const removeAll = () => {
    if (!window.confirm('기억한 것을 모두 지울까요? 되돌릴 수 없어요.')) return;
    void run(async () => {
      await api('/me/memories', { method: 'DELETE' });
      setItems([]);
    });
  };

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={user.memoryEnabled}
          onClick={() => void toggle()}
          disabled={busy}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            user.memoryEnabled ? 'bg-clay-500' : 'bg-sand-300 dark:bg-sand-600'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${user.memoryEnabled ? 'translate-x-5' : ''}`}
          />
        </button>
        <span className="text-sm">
          <span className="font-medium">{user.memoryEnabled ? '기억 켜짐' : '기억 꺼짐'}</span>
          <span className="mt-0.5 block text-sand-500">
            {user.memoryEnabled
              ? '대화에서 알게 된 나에 대한 것(이름, 전공, 관심사, "기억해"라고 한 것 등)을 기억해서 다른 대화에서도 써요. 비밀번호·번호·건강 같은 민감한 내용은 기억하지 않아요.'
              : '새로 기억하지 않고, 기억한 것도 대화에 쓰지 않아요. 목록은 남아 있어요.'}
          </span>
        </span>
      </label>

      <form onSubmit={add} className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={200}
          placeholder="직접 적어 넣기 (예: 나는 컴퓨터공학과 2학년이야)"
          aria-label="기억할 내용"
          className={`${inputClass.replace('w-full ', '')} min-w-0 flex-1`}
        />
        <PrimaryButton type="submit" disabled={busy || draft.trim().length < 2} className="shrink-0 px-3">
          추가
        </PrimaryButton>
      </form>

      {error && <ErrorBox>{error}</ErrorBox>}
      {items === null && !error && <p className="text-sm text-sand-500">불러오는 중…</p>}
      {items?.length === 0 && <p className="text-sm text-sand-500">아직 기억한 것이 없어요.</p>}
      {items && items.length > 0 && (
        <>
          <ul className="divide-y divide-sand-100 rounded-xl border border-sand-200 dark:divide-sand-700 dark:border-sand-700">
            {items.map((m) => (
              <li key={m.id} className="flex items-start gap-2 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 wrap-anywhere">{m.content}</span>
                {m.conversationId ? (
                  <Link to={`/chat/${m.conversationId}`} className="shrink-0 text-xs text-sand-400 hover:text-sand-800 dark:hover:text-sand-100">
                    {new Date(m.createdAt).toLocaleDateString('ko-KR')} 대화
                  </Link>
                ) : (
                  <span className="shrink-0 text-xs text-sand-400">직접 적음</span>
                )}
                <button
                  type="button"
                  onClick={() => void remove(m)}
                  disabled={busy}
                  aria-label="이 기억 지우기"
                  className="shrink-0 rounded p-0.5 text-sand-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  <TrashIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between text-xs text-sand-400">
            <span>
              {items.length} / {max}개
            </span>
            <SecondaryButton type="button" onClick={removeAll} disabled={busy} className="px-3 py-1.5 text-xs hover:text-red-600">
              모두 지우기
            </SecondaryButton>
          </div>
        </>
      )}
    </div>
  );
}
