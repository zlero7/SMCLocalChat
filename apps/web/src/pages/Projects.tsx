import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PlusIcon, ProjectIcon } from '../components/Icons';
import { ErrorBox, PrimaryButton, SecondaryButton, inputClass } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Project } from '../lib/types';
import { useProjects } from '../store/projects';

/** 새 프로젝트 만들기 */
function CreateForm({ onCancel }: { onCancel(): void }) {
  const nameId = useId();
  const descId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await api<{ project: Project }>('/projects', { body: { name, description } });
      useProjects.getState().upsert(project);
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-2xl border border-sand-200 bg-white p-5 dark:border-sand-800 dark:bg-sand-800/50"
    >
      <h2 className="text-base font-semibold">새 프로젝트</h2>
      <div>
        <label htmlFor={nameId} className="mb-1.5 block text-sm font-medium text-sand-700 dark:text-sand-300">
          이름
        </label>
        <input
          id={nameId}
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="예: 졸업 작품, 영어 공부, 회사 업무"
          className={inputClass}
          required
        />
      </div>
      <div>
        <label htmlFor={descId} className="mb-1.5 block text-sm font-medium text-sand-700 dark:text-sand-300">
          설명 (선택)
        </label>
        <input
          id={descId}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={300}
          placeholder="이 프로젝트가 무엇인지 한 줄로"
          className={inputClass}
        />
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="flex gap-2">
        <PrimaryButton type="submit" disabled={busy || !name.trim()}>
          {busy ? '만드는 중…' : '만들기'}
        </PrimaryButton>
        <SecondaryButton type="button" onClick={onCancel}>
          취소
        </SecondaryButton>
      </div>
    </form>
  );
}

/** 내 프로젝트 목록 */
export default function Projects() {
  const items = useProjects((s) => s.items);
  const loaded = useProjects((s) => s.loaded);
  const max = useProjects((s) => s.max);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void useProjects.getState().load();
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 pb-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">프로젝트</h1>
            <p className="mt-1 text-sm text-sand-500">
              주제별로 대화를 묶고, 그 안의 모든 대화에 공통 지침과 자료를 줘요.
            </p>
          </div>
          {!creating && (
            <PrimaryButton
              type="button"
              onClick={() => setCreating(true)}
              disabled={items.length >= max}
              title={items.length >= max ? `프로젝트는 ${max}개까지 만들 수 있어요` : undefined}
              className="flex items-center gap-1.5"
            >
              <PlusIcon size={16} strokeWidth={2.5} /> 새 프로젝트
            </PrimaryButton>
          )}
        </div>

        {creating && <CreateForm onCancel={() => setCreating(false)} />}
        {!loaded && <p className="text-sm text-sand-500">불러오는 중…</p>}

        {loaded && items.length === 0 && !creating && (
          <div className="rounded-2xl border border-dashed border-sand-300 p-8 text-center dark:border-sand-700">
            <ProjectIcon size={28} className="mx-auto text-sand-400" />
            <p className="mt-2 font-medium">아직 프로젝트가 없어요</p>
            <p className="mt-1 text-sm text-sand-500">
              예를 들어 "졸업 작품" 프로젝트에 자료를 넣어 두면, 그 안의 모든 대화에서 AI 가 그 자료를 알고 답해요.
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((p) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="block rounded-2xl border border-sand-200 bg-white p-4 transition-colors hover:border-sand-300 dark:border-sand-800 dark:bg-sand-800/50 dark:hover:border-sand-700"
            >
              <div className="flex items-center gap-2">
                <ProjectIcon size={16} className="shrink-0 text-clay-500" />
                <h2 className="truncate font-semibold">{p.name}</h2>
              </div>
              {p.description && <p className="mt-1 line-clamp-2 text-sm text-sand-500">{p.description}</p>}
              <p className="mt-3 text-xs text-sand-400">
                대화 {p.conversationCount}개 · 자료 {p.fileCount}개 · {new Date(p.updatedAt).toLocaleDateString('ko-KR')}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
