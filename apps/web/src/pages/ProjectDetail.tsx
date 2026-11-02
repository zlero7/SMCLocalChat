import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FileIcon, PaperclipIcon, PencilIcon, PlusIcon, ProjectIcon, TrashIcon } from '../components/Icons';
import { ErrorBox, PrimaryButton, SecondaryButton, inputClass } from '../components/ui';
import { ApiError, api, errorMessage } from '../lib/api';
import type { Project, ProjectDetail as Detail, ProjectFile } from '../lib/types';
import { downloadFile, formatSize, uploadFile } from '../lib/upload';
import { useProjects } from '../store/projects';

const DOC_ACCEPT = '.pdf,.docx,.txt,.md,.csv,.tsv,.json,.xml,.yaml,.yml,.log,.py,.js,.ts,.tsx,.jsx,.java,.c,.cpp,.h,.cs,.go,.rs,.sql,.html,.css';

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-sand-200 bg-white p-5 dark:border-sand-800 dark:bg-sand-800/50">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm leading-relaxed text-sand-500 dark:text-sand-400">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function ProjectDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 이름·설명 고치기
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // 지침
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // 자료 올리기
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);

  const load = async () => {
    try {
      const d = await api<Detail>(`/projects/${id}`);
      setData(d);
      setName(d.project.name);
      setDescription(d.project.description);
      setInstructions(d.project.instructions);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) navigate('/projects', { replace: true });
      else setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const patch = async (body: Partial<Pick<Project, 'name' | 'description' | 'instructions'>>, okText: string) => {
    setSaving(true);
    setSaved(null);
    try {
      const { project } = await api<{ project: Project }>(`/projects/${id}`, { method: 'PATCH', body });
      setData((d) => (d ? { ...d, project: { ...d.project, ...project } } : d));
      useProjects.getState().upsert(project);
      setSaved(okText);
      return true;
    } catch (err) {
      setSaved(null);
      setError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    setFileError(null);
    for (const file of files) {
      setUploading((u) => [...u, file.name]);
      try {
        const uploaded = await uploadFile(file);
        const { file: added } = await api<{ file: ProjectFile }>(`/projects/${id}/files`, { body: { fileId: uploaded.id } });
        setData((d) => (d ? { ...d, files: [...d.files, added] } : d));
      } catch (err) {
        setFileError(`${file.name}: ${errorMessage(err)}`);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
    void useProjects.getState().load();
  };

  const removeFile = async (f: ProjectFile) => {
    if (!window.confirm(`자료 "${f.name}"을(를) 지울까요?`)) return;
    try {
      await api(`/projects/${id}/files/${f.id}`, { method: 'DELETE' });
      setData((d) => (d ? { ...d, files: d.files.filter((x) => x.id !== f.id) } : d));
      void useProjects.getState().load();
    } catch (err) {
      setFileError(errorMessage(err));
    }
  };

  const removeProject = async () => {
    if (!data) return;
    if (!window.confirm(`"${data.project.name}" 프로젝트를 지울까요?\n자료는 함께 지워지고, 대화는 남아서 프로젝트에서만 빠져요.`)) return;
    try {
      await api(`/projects/${id}`, { method: 'DELETE' });
      useProjects.getState().remove(id);
      navigate('/projects');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        {error ? <ErrorBox>{error}</ErrorBox> : <p className="text-sm text-sand-500">불러오는 중…</p>}
      </div>
    );
  }

  const totalChars = data.files.reduce((s, f) => s + f.chars, 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 pb-12">
        <Link to="/projects" className="text-sm text-sand-500 hover:text-sand-900 dark:hover:text-sand-100">
          ← 프로젝트 목록
        </Link>

        {editingName ? (
          <div className="space-y-2">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="프로젝트 이름" className={inputClass} />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={300}
              placeholder="설명 (선택)"
              aria-label="프로젝트 설명"
              className={inputClass}
            />
            <div className="flex gap-2">
              <PrimaryButton
                type="button"
                disabled={saving || !name.trim()}
                onClick={() => void patch({ name, description }, '저장했어요.').then((ok) => ok && setEditingName(false))}
                className="px-3 py-2"
              >
                저장
              </PrimaryButton>
              <SecondaryButton
                type="button"
                onClick={() => {
                  setName(data.project.name);
                  setDescription(data.project.description);
                  setEditingName(false);
                }}
                className="px-3 py-2"
              >
                취소
              </SecondaryButton>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <ProjectIcon size={24} className="mt-1 shrink-0 text-clay-500" />
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold tracking-tight wrap-anywhere">{data.project.name}</h1>
              {data.project.description && <p className="mt-1 text-sm text-sand-500">{data.project.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => setEditingName(true)}
              aria-label="이름 고치기"
              title="이름·설명 고치기"
              className="rounded-lg p-2 text-sand-500 hover:bg-sand-100 hover:text-sand-900 dark:hover:bg-sand-800 dark:hover:text-sand-100"
            >
              <PencilIcon size={16} />
            </button>
          </div>
        )}

        {error && <ErrorBox>{error}</ErrorBox>}

        <PrimaryButton type="button" onClick={() => navigate(`/chat?project=${id}`)} className="flex items-center gap-1.5">
          <PlusIcon size={16} strokeWidth={2.5} /> 이 프로젝트에서 새 대화
        </PrimaryButton>

        <Section
          title="프로젝트 지침"
          description="이 프로젝트의 모든 대화에 들어가는 지침이에요. 예: 답은 항상 표로 정리해 줘 / 나는 이 과목 초보야 / 코드는 파이썬으로."
        >
          <textarea
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
              setSaved(null);
            }}
            rows={5}
            maxLength={4000}
            placeholder="이 프로젝트에서 AI 가 지킬 것"
            className={`${inputClass} resize-y`}
          />
          <div className="mt-3 flex items-center gap-3">
            <PrimaryButton
              type="button"
              disabled={saving || instructions === data.project.instructions}
              onClick={() => void patch({ instructions }, '지침을 저장했어요.')}
            >
              {saving ? '저장 중…' : '지침 저장'}
            </PrimaryButton>
            {saved && <span className="text-sm text-clay-600 dark:text-clay-400">{saved}</span>}
          </div>
        </Section>

        <Section
          title={`자료 (${data.files.length}개)`}
          description="PDF·워드·텍스트 문서를 넣어 두면 AI 가 이 프로젝트의 대화에서 참고해요. 자료가 많으면 질문과 관련된 부분만 골라서 읽어요."
        >
          {data.files.length > 0 && (
            <ul className="mb-3 divide-y divide-sand-100 dark:divide-sand-700">
              {data.files.map((f) => (
                <li key={f.id} className="flex items-center gap-2 py-2">
                  <FileIcon size={16} className="shrink-0 text-sand-500" />
                  <button
                    type="button"
                    onClick={() => void downloadFile(f).catch(() => setFileError('파일을 내려받지 못했어요.'))}
                    className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                    title={`${f.name} 내려받기`}
                  >
                    {f.name}
                  </button>
                  <span className="shrink-0 text-xs text-sand-400">
                    {formatSize(f.size)} · 글자 {f.chars.toLocaleString()}자
                  </span>
                  <button
                    type="button"
                    onClick={() => void removeFile(f)}
                    aria-label={`${f.name} 지우기`}
                    className="shrink-0 rounded p-1 text-sand-400 hover:text-red-600 dark:hover:text-red-400"
                  >
                    <TrashIcon size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {uploading.length > 0 && <p className="mb-2 text-sm text-sand-500">올리는 중: {uploading.join(', ')}</p>}
          {fileError && (
            <div className="mb-2">
              <ErrorBox>{fileError}</ErrorBox>
            </div>
          )}
          <SecondaryButton type="button" onClick={() => fileInput.current?.click()} className="flex items-center gap-1.5 px-3 py-2">
            <PaperclipIcon size={15} /> 자료 넣기
          </SecondaryButton>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={DOC_ACCEPT}
            className="hidden"
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {totalChars > 0 && (
            <p className="mt-2 text-xs text-sand-400">
              전체 {totalChars.toLocaleString()}자. 질문 하나에 약 5,000자까지 관련 부분을 골라 AI 에게 보여 줘요.
            </p>
          )}
        </Section>

        <Section title={`대화 (${data.conversations.length}개)`}>
          {data.conversations.length === 0 ? (
            <p className="text-sm text-sand-500">아직 이 프로젝트의 대화가 없어요.</p>
          ) : (
            <ul className="space-y-0.5">
              {data.conversations.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/chat/${c.id}`}
                    className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-sand-100 dark:hover:bg-sand-800"
                  >
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 text-xs text-sand-400">{new Date(c.updatedAt).toLocaleDateString('ko-KR')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="pt-2 text-right">
          <button type="button" onClick={() => void removeProject()} className="text-sm text-sand-400 hover:text-red-600 dark:hover:text-red-400">
            프로젝트 지우기
          </button>
        </div>
      </div>
    </div>
  );
}
