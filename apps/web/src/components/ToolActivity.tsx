import type { ReactNode } from 'react';
import type { ToolPreview, ToolRequest, ToolStep } from '../lib/types';
import type { PermissionMode } from '../store/permission';
import {
  CheckIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  LinkIcon,
  MailIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from './Icons';

const LABELS: Record<
  string,
  {
    label: string;
    icon: (p: { size?: number; className?: string }) => ReactNode;
  }
> = {
  list_dir: { label: '폴더 보기', icon: FolderIcon },
  read_file: { label: '파일 읽기', icon: FileIcon },
  search_files: { label: '찾기', icon: SearchIcon },
  write_file: { label: '파일 쓰기', icon: PencilIcon },
  edit_file: { label: '파일 고치기', icon: PencilIcon },
  make_dir: { label: '폴더 만들기', icon: PlusIcon },
  delete_path: { label: '지우기', icon: TrashIcon },
  move_path: { label: '옮기기·이름 바꾸기', icon: FileIcon },
  copy_path: { label: '복사', icon: FileIcon },
  run_command: { label: '명령 실행', icon: FileIcon },
  find_files: { label: '이름으로 찾기', icon: SearchIcon },
  web_search: { label: '웹 검색', icon: GlobeIcon },
  fetch_url: { label: '페이지 읽기', icon: LinkIcon },
  gmail_search: { label: '메일 찾기', icon: MailIcon },
  gmail_read: { label: '메일 읽기', icon: MailIcon },
};

/** 진행 중일 때 보여 줄 말 */
const RUNNING: Record<string, string> = {
  web_search: '찾는 중…',
  fetch_url: '읽는 중…',
  gmail_search: '메일 찾는 중…',
  gmail_read: '메일 읽는 중…',
};

/** 주소는 "example.com/경로" 처럼 짧게 */
const shortUrl = (u: string) => {
  try {
    const url = new URL(u);
    const path = decodeURIComponent(url.pathname).replace(/\/$/, '');
    return `${url.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return u;
  }
};

const target = (step: { args: Record<string, unknown> }) => {
  const { path, query, url } = step.args;
  if (typeof query === 'string') return `"${query}"`;
  if (typeof url === 'string') return shortUrl(url);
  return typeof path === 'string' ? path : '';
};

/** AI 가 한 파일 작업 목록 (Claude Code 의 도구 사용 표시처럼) */
export function ToolSteps({ steps }: { steps: ToolStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="mb-3 space-y-1 rounded-xl border border-sand-200 bg-sand-100/60 px-3 py-2 text-sm dark:border-sand-700 dark:bg-sand-800/50">
      {steps.map((s) => {
        const meta = LABELS[s.name] ?? { label: s.name, icon: FileIcon };
        const Icon = meta.icon;
        return (
          <li key={s.id} className="py-0.5">
            <div className="flex min-w-0 items-start gap-2">
              <Icon size={14} className="mt-[3px] shrink-0 text-sand-500" />
              <span className="shrink-0 text-sand-600 dark:text-sand-300">{meta.label}</span>
              {typeof s.args.url === 'string' ? (
                <a
                  href={s.args.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="min-w-0 truncate font-mono text-[12.5px] text-sand-800 underline-offset-2 hover:underline dark:text-sand-100"
                  title={s.args.url}
                >
                  {target(s)}
                </a>
              ) : (
                <code
                  className="min-w-0 truncate font-mono text-[12.5px] text-sand-800 dark:text-sand-100"
                  title={target(s)}
                >
                  {target(s)}
                </code>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-xs">
                {s.status === 'running' && (
                  <span className="flex items-center gap-1.5 text-sand-500">
                    <span
                      className="size-3 animate-spin rounded-full border-2 border-sand-300 border-t-clay-500"
                      aria-hidden="true"
                    />
                    {RUNNING[s.name] ?? '실행 중…'}
                  </span>
                )}
                {s.status === 'ok' && (
                  <span className="flex items-center gap-1 text-sand-500" title={s.summary}>
                    <CheckIcon size={13} className="text-emerald-600 dark:text-emerald-400" />
                    <span className="hidden max-w-[16rem] truncate sm:inline">{s.summary}</span>
                  </span>
                )}
                {s.status === 'denied' && <span className="text-amber-600 dark:text-amber-400">거절함</span>}
                {s.status === 'error' && (
                  <span
                    className="flex max-w-[18rem] items-center gap-1 text-red-600 dark:text-red-400"
                    title={s.summary}
                  >
                    <CloseIcon size={13} />
                    <span className="truncate">{s.summary}</span>
                  </span>
                )}
              </span>
            </div>
            {s.sources && s.sources.length > 0 && (
              // 검색이 찾은 출처 (모델이 답에 링크를 빠뜨려도 여기서 확인할 수 있다)
              <div className="mt-1 ml-[22px] flex flex-wrap gap-1">
                {s.sources.map((src) => (
                  <a
                    key={src.url}
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    title={`${src.title}\n${src.url}`}
                    className="max-w-[14rem] truncate rounded-md border border-sand-200 bg-white px-1.5 py-0.5 text-xs text-sand-600 hover:border-sand-300 hover:text-sand-900 dark:border-sand-700 dark:bg-sand-900 dark:text-sand-300 dark:hover:text-sand-50"
                  >
                    {shortUrl(src.url).split('/')[0]} · {src.title}
                  </a>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PreviewBody({ preview }: { preview: ToolPreview }) {
  const box =
    'max-h-72 overflow-auto rounded-lg px-3 py-2 font-mono text-[12.5px] leading-5 whitespace-pre-wrap wrap-anywhere';
  switch (preview.kind) {
    case 'write':
      return (
        <>
          <pre className={`${box} bg-white dark:bg-sand-900`}>{preview.content || '(빈 파일)'}</pre>
          {preview.truncated && <p className="mt-1 text-xs text-sand-500">…앞부분만 보여 줘요</p>}
        </>
      );
    case 'edit':
      return (
        <div className="space-y-1.5">
          <pre className={`${box} bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200`}>
            {preview.oldText
              .split('\n')
              .map((l) => `- ${l}`)
              .join('\n')}
          </pre>
          <pre className={`${box} bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200`}>
            {preview.newText
              .split('\n')
              .map((l) => `+ ${l}`)
              .join('\n')}
          </pre>
        </div>
      );
    case 'delete':
      return (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {preview.isDir ? '폴더와 그 안의 모든 파일이' : '이 파일이'} 지워져요. 되돌릴 수 없어요.
        </p>
      );
    case 'run':
      return (
        <div className="space-y-1.5">
          <pre className={`${box} bg-sand-900 text-sand-50 dark:bg-black`}>{'$ ' + preview.command}</pre>
          <p className="text-xs text-sand-500">
            내 컴퓨터의 "{preview.path}" 폴더에서 실행돼요 · 최대 {preview.timeoutSec}초 · 위험한 명령이면 도우미가 거절해요
          </p>
        </div>
      );
    case 'move':
      return (
        <p className="rounded-lg bg-white px-3 py-2 font-mono text-[13px] break-all dark:bg-sand-900">
          {preview.path}
          <span className="mx-1.5 text-sand-500">→</span>
          <span className="text-clay-700 dark:text-clay-300">{preview.to}</span>
        </p>
      );
    case 'mkdir':
      return null;
  }
}

const titleOf = (p: ToolPreview) =>
  p.kind === 'write'
    ? p.exists
      ? '파일을 덮어쓸까요?'
      : '새 파일을 만들까요?'
    : p.kind === 'edit'
      ? '파일을 고칠까요?'
      : p.kind === 'mkdir'
        ? '폴더를 만들까요?'
        : p.kind === 'run'
          ? '내 컴퓨터에서 이 명령을 실행할까요?'
          : p.kind === 'move'
          ? p.copy
            ? '복사할까요?'
            : '옮기거나 이름을 바꿀까요?'
          : '지울까요?';

/** 파일을 바꾸기 전 허용을 묻는 카드 (Claude Code 의 권한 확인처럼) */
export function ApprovalCard({
  request,
  deciding,
  onDecide,
}: {
  request: ToolRequest;
  deciding: boolean;
  onDecide(approve: boolean, switchMode?: PermissionMode): void;
}) {
  const p = request.preview;
  return (
    <div
      role="alertdialog"
      aria-label={titleOf(p)}
      className="mb-3 rounded-xl border border-clay-300 bg-clay-50/70 p-3.5 shadow-sm dark:border-clay-800 dark:bg-clay-950/30"
    >
      <p className="text-sm font-semibold text-sand-900 dark:text-sand-50">{titleOf(p)}</p>
      <p className="mt-0.5 mb-2.5 font-mono text-[13px] break-all text-clay-700 dark:text-clay-300">{p.path}</p>
      <PreviewBody preview={p} />
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onDecide(true)}
          disabled={deciding}
          autoFocus
          className="rounded-lg bg-clay-500 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-clay-600 disabled:opacity-50"
        >
          허용
        </button>
        {p.kind !== 'delete' && p.kind !== 'run' && (
          <button
            type="button"
            onClick={() => onDecide(true, 'edits')}
            disabled={deciding}
            title="이후 파일 만들기·고치기·옮기기는 묻지 않아요. 권한은 입력창의 '권한'에서 다시 바꿀 수 있어요"
            className="rounded-lg border border-clay-300 bg-white px-3.5 py-1.5 text-sm text-clay-700 hover:bg-clay-50 disabled:opacity-50 dark:border-clay-700 dark:bg-sand-800 dark:text-clay-300 dark:hover:bg-sand-700"
          >
            허용하고 앞으로 묻지 않기
          </button>
        )}
        <button
          type="button"
          onClick={() => onDecide(false)}
          disabled={deciding}
          className="rounded-lg border border-sand-300 bg-white px-3.5 py-1.5 text-sm hover:bg-sand-100 disabled:opacity-50 dark:border-sand-600 dark:bg-sand-800 dark:hover:bg-sand-700"
        >
          거절
        </button>
        <span className="text-xs text-sand-500">{deciding ? '보내는 중…' : '10분 안에 답하지 않으면 거절돼요'}</span>
      </div>
    </div>
  );
}
