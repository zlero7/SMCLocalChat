import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import type { Conversation, ConversationDetail } from '../lib/types';
import { useChats } from '../store/chats';
import { useProjects } from '../store/projects';
import { CopyButton } from './CopyButton';
import { CloseIcon, MoreIcon, ProjectIcon, ShareIcon } from './Icons';
import { Menu } from './Menu';
import { ErrorBox, PrimaryButton, SecondaryButton } from './ui';

interface Share {
  token: string;
  path: string;
  createdAt: string;
}

/** 대화를 마크다운 글로 (제목, 질문·답변, 웹 검색 출처) */
function toMarkdown(detail: ConversationDetail): string {
  const lines = [`# ${detail.conversation.title}`, '', `> 저장한 날: ${new Date().toLocaleString('ko-KR')}`, ''];
  for (const m of detail.messages) {
    if (m.role === 'user') {
      lines.push('## 나', '', m.content, '');
      for (const a of m.attachments ?? []) lines.push(`- 첨부: ${a.name}`);
      if (m.attachments?.length) lines.push('');
    } else {
      lines.push(`## AI${m.model ? ` (${m.model})` : ''}`, '', m.content || '(답변 없음)', '');
      const sources = (m.tools ?? []).flatMap((t) => t.sources ?? []);
      if (sources.length) {
        lines.push('출처:', ...sources.map((s) => `- [${s.title}](${s.url})`), '');
      }
    }
  }
  return lines.join('\n');
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 공유 링크 만들기·복사·끄기 */
function ShareDialog({ id, onClose }: { id: string; onClose(): void }) {
  const [share, setShare] = useState<Share | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ share: Share | null }>(`/conversations/${id}/share`)
      .then((d) => setShare(d.share))
      .catch((err) => setError(errorMessage(err)));
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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

  const link = share ? `${window.location.origin}${share.path}` : '';
  const isLocal = /^(localhost|127\.|\[::1\])/.test(window.location.host);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="대화 공유"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-sand-800"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">대화 공유</h2>
          <button type="button" onClick={onClose} aria-label="닫기" className="rounded p-1 text-sand-500 hover:text-sand-900 dark:hover:text-sand-100">
            <CloseIcon size={16} />
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-sand-500 dark:text-sand-400">
          링크를 아는 사람은 로그인 없이 이 대화를 읽을 수 있어요. 지금까지의 대화만 보이고, 뒤에 이어서 나눈 대화는 다시 공유해야 보여요.
          첨부 파일은 이름만 보여요.
        </p>
        {share === undefined && !error && <p className="mt-4 text-sm text-sand-500">불러오는 중…</p>}
        {share && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-2 rounded-xl border border-sand-300 bg-sand-50 px-3 py-2 dark:border-sand-700 dark:bg-sand-900">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{link}</span>
              <CopyButton text={link} label="링크 복사" className="shrink-0 text-xs text-clay-700 dark:text-clay-300" />
            </div>
            <p className="text-xs text-sand-400">공유한 때: {new Date(share.createdAt).toLocaleString('ko-KR')}</p>
            {isLocal && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                주소가 localhost 라서 이 PC 에서만 열려요. 다른 사람에게 보내려면 이 PC 의 IP 주소나 도메인으로 사이트를 열고 링크를 다시 복사하세요.
              </p>
            )}
          </div>
        )}
        {error && (
          <div className="mt-3">
            <ErrorBox>{error}</ErrorBox>
          </div>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {share && (
            <SecondaryButton
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(`/conversations/${id}/share`, { method: 'DELETE' });
                  setShare(null);
                })
              }
              className="px-3 py-2 hover:text-red-600 dark:hover:text-red-400"
            >
              공유 끄기
            </SecondaryButton>
          )}
          {share !== undefined && (
            <PrimaryButton
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setShare((await api<{ share: Share }>(`/conversations/${id}/share`, { method: 'POST' })).share);
                })
              }
              className="px-3 py-2"
            >
              {share ? '지금 대화까지 다시 공유' : '공유 링크 만들기'}
            </PrimaryButton>
          )}
        </div>
      </div>
    </div>
  );
}

/** 대화를 프로젝트로 옮기거나 프로젝트에서 빼기 */
function MoveDialog({ id, current, onClose }: { id: string; current: string | null; onClose(): void }) {
  const projects = useProjects((s) => s.items);
  const loaded = useProjects((s) => s.loaded);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void useProjects.getState().load();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [loaded, onClose]);

  const move = async (projectId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await api<{ conversation: Conversation }>(`/conversations/${id}`, {
        method: 'PATCH',
        body: { projectId },
      });
      useChats.getState().upsert(conversation);
      void useProjects.getState().load(); // 대화 수가 바뀌었다
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="프로젝트로 옮기기"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl dark:bg-sand-800"
      >
        <h2 className="text-base font-semibold">프로젝트로 옮기기</h2>
        <p className="mt-1 text-sm text-sand-500">옮기면 다음 질문부터 그 프로젝트의 지침과 자료를 함께 써요.</p>
        <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={busy || p.id === current}
                onClick={() => void move(p.id)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-sand-100 disabled:opacity-50 dark:hover:bg-sand-700"
              >
                <ProjectIcon size={15} className="shrink-0 text-sand-500" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.id === current && <span className="text-xs text-sand-400">지금 여기</span>}
              </button>
            </li>
          ))}
          {loaded && projects.length === 0 && (
            <li className="px-3 py-2 text-sm text-sand-500">
              아직 프로젝트가 없어요.{' '}
              <Link to="/projects" onClick={onClose} className="text-clay-600 underline dark:text-clay-400">
                프로젝트 만들기
              </Link>
            </li>
          )}
        </ul>
        {error && (
          <div className="mt-3">
            <ErrorBox>{error}</ErrorBox>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {current && (
            <SecondaryButton type="button" disabled={busy} onClick={() => void move(null)} className="px-3 py-2">
              프로젝트에서 빼기
            </SecondaryButton>
          )}
          <SecondaryButton type="button" onClick={onClose} className="px-3 py-2">
            닫기
          </SecondaryButton>
        </div>
      </div>
    </div>
  );
}

/** 대화 화면 위쪽: 속한 프로젝트, 공유 버튼, 더 보기 메뉴 (프로젝트로 옮기기, 마크다운·PDF 로 저장) */
export function ConversationActions({ id }: { id: string }) {
  const [sharing, setSharing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectId = useChats((s) => s.items.find((c) => c.id === id)?.projectId ?? null);
  const project = useProjects((s) => (projectId ? s.items.find((p) => p.id === projectId) : undefined));

  const exportMarkdown = async () => {
    setError(null);
    try {
      const detail = await api<ConversationDetail>(`/conversations/${id}`);
      const safe = detail.conversation.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || '대화';
      download(`${safe}.md`, toMarkdown(detail));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="flex items-center gap-1 print:hidden">
      {error && (
        <span role="alert" className="max-w-[12rem] truncate text-xs text-red-600" title={error}>
          {error}
        </span>
      )}
      {projectId && (
        <Link
          to={`/projects/${projectId}`}
          title="이 대화가 속한 프로젝트"
          className="hidden max-w-[10rem] items-center gap-1 truncate rounded-lg px-2 py-1 text-xs text-sand-500 hover:bg-sand-100 hover:text-sand-900 sm:flex dark:hover:bg-sand-800 dark:hover:text-sand-50"
        >
          <ProjectIcon size={13} className="shrink-0" />
          <span className="truncate">{project?.name ?? '프로젝트'}</span>
        </Link>
      )}
      <button
        type="button"
        onClick={() => setSharing(true)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-sand-600 hover:bg-sand-100 hover:text-sand-900 dark:text-sand-300 dark:hover:bg-sand-800 dark:hover:text-sand-50"
      >
        <ShareIcon size={15} />
        <span className="hidden sm:inline">공유</span>
      </button>
      <Menu
        placement="down"
        align="right"
        triggerLabel="대화 더 보기"
        title="더 보기"
        trigger={<MoreIcon size={18} />}
        groups={[
          {
            items: [
              {
                key: 'move',
                label: projectId ? '다른 프로젝트로 옮기기' : '프로젝트로 옮기기',
                description: projectId ? '또는 프로젝트에서 빼기' : '프로젝트의 지침과 자료를 함께 써요',
                onSelect: () => setMoving(true),
              },
              {
                key: 'md',
                label: '마크다운으로 저장',
                description: '.md 파일로 내려받아요',
                onSelect: () => void exportMarkdown(),
              },
              {
                key: 'pdf',
                label: 'PDF로 저장 / 인쇄',
                description: '인쇄 창에서 "PDF로 저장"을 고르세요',
                onSelect: () => window.print(),
              },
            ],
          },
        ]}
      />
      {sharing && <ShareDialog id={id} onClose={() => setSharing(false)} />}
      {moving && <MoveDialog id={id} current={projectId} onClose={() => setMoving(false)} />}
    </div>
  );
}
