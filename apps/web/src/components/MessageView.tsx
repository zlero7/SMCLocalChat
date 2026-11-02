import { memo, useEffect, useState } from 'react';
import type { Attachment, MessageStatus, ToolRequest, ToolStep } from '../lib/types';
import { downloadFile, fileObjectUrl, formatSize } from '../lib/upload';
import { modelLabel, useModels } from '../store/models';
import type { Phase } from '../store/stream';
import { CopyButton } from './CopyButton';
import { ChevronIcon, FileIcon, PencilIcon, RefreshIcon } from './Icons';
import { Markdown } from './Markdown';
import { ApprovalCard, ToolSteps } from './ToolActivity';
import type { PermissionMode } from '../store/permission';

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  status: MessageStatus;
  model: string | null;
  /** 답변을 만들며 AI 가 한 파일 작업 */
  tools: ToolStep[];
  /** 사용자 메시지에 붙인 파일 */
  attachments?: Attachment[];
}

/** 로그인해야 받을 수 있는 이미지 (토큰을 붙여 받은 뒤 보여 준다) */
function AuthImage({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    fileObjectUrl(attachment.id)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [attachment.id]);
  if (failed) {
    return (
      <span className="grid h-24 w-32 place-items-center rounded-xl border border-sand-200 text-xs text-sand-400 dark:border-sand-700">
        이미지를 열 수 없어요
      </span>
    );
  }
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" title={`${attachment.name} (크게 보기)`}>
      <img src={url} alt={attachment.name} className="max-h-48 max-w-[16rem] rounded-xl border border-sand-200 object-cover dark:border-sand-700" />
    </a>
  ) : (
    <span className="block h-24 w-32 animate-pulse rounded-xl bg-sand-100 dark:bg-sand-800" />
  );
}

/** 메시지에 붙인 파일들 */
function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {attachments.map((a) =>
        a.kind === 'image' ? (
          <AuthImage key={a.id} attachment={a} />
        ) : (
          <button
            key={a.id}
            type="button"
            onClick={() => void downloadFile(a).catch(() => window.alert('파일을 내려받지 못했어요.'))}
            title={`${a.name} 내려받기`}
            className="flex max-w-[16rem] items-center gap-2 rounded-xl border border-sand-200 bg-white px-2.5 py-2 text-left text-xs hover:border-sand-300 dark:border-sand-700 dark:bg-sand-900"
          >
            <FileIcon size={16} className="shrink-0 text-sand-500" />
            <span className="min-w-0">
              <span className="block truncate font-medium">{a.name}</span>
              <span className="text-sand-400">{formatSize(a.size)}</span>
            </span>
          </button>
        ),
      )}
    </div>
  );
}

const smallButton =
  'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-sand-500 transition-colors hover:bg-sand-100 hover:text-sand-800 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-sand-800 dark:hover:text-sand-100';

/**
 * 내가 보낸 메시지. onEdit 이 있으면 마우스를 올렸을 때 "고치기"가 보이고,
 * 고쳐서 보내면 이 메시지 뒤의 대화는 지워지고 새로 이어진다.
 */
export const UserMessage = memo(function UserMessage({
  content,
  attachments = [],
  onEdit,
  canEdit = true,
}: {
  content: string;
  attachments?: Attachment[];
  /** 고친 글로 다시 보낸다 (붙인 파일은 그대로 다시 붙는다) */
  onEdit?(text: string): void;
  /** 다른 답변을 만드는 중이면 false */
  canEdit?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);

  if (editing && onEdit) {
    const submit = () => {
      const text = draft.trim();
      if (!text) return;
      setEditing(false);
      if (text !== content) onEdit(text);
    };
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[85%] rounded-2xl border border-sand-300 bg-white p-3 dark:border-sand-700 dark:bg-sand-900">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') setEditing(false);
            }}
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            aria-label="메시지 고치기"
            className="block w-full resize-y bg-transparent text-[15px] leading-7 outline-none"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-sand-400">보내면 이 메시지 뒤의 대화는 지워져요</span>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-lg px-3 py-1.5 text-sm text-sand-600 hover:bg-sand-100 dark:text-sand-300 dark:hover:bg-sand-800"
            >
              취소
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className="rounded-lg bg-clay-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-clay-700 disabled:opacity-50"
            >
              보내기
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end">
      <MessageAttachments attachments={attachments} />
      <div className="max-w-[85%] rounded-2xl bg-sand-200/70 px-4 py-2.5 text-[15px] leading-7 wrap-anywhere whitespace-pre-wrap dark:bg-sand-950">
        {content}
      </div>
      {onEdit && (
        <div className="mt-1 flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <CopyButton text={content} label="복사" className={smallButton} />
          <button
            type="button"
            onClick={() => {
              setDraft(content);
              setEditing(true);
            }}
            disabled={!canEdit}
            title={canEdit ? '고쳐서 다시 보내기' : '답변이 끝난 뒤에 고칠 수 있어요'}
            className={smallButton}
          >
            <PencilIcon size={13} /> 고치기
          </button>
        </div>
      )}
    </div>
  );
});

/** 모델의 생각 과정. 답변이 시작되면 자동으로 접힌다. */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);
  if (!text) return null;
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-md py-0.5 text-sm text-sand-500 hover:text-sand-800 dark:text-sand-400 dark:hover:text-sand-200"
        aria-expanded={open}
      >
        {live ? (
          <span className="size-3.5 animate-spin rounded-full border-2 border-sand-300 border-t-clay-500" aria-hidden="true" />
        ) : (
          <ChevronIcon size={15} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        )}
        <span className={live ? 'thinking-shimmer' : ''}>{live ? '생각하는 중…' : '생각 과정'}</span>
        {live && <ChevronIcon size={15} className={`transition-transform ${open ? 'rotate-90' : ''}`} />}
      </button>
      {open && (
        <div className="mt-1.5 max-h-72 overflow-y-auto border-l-2 border-sand-300 pl-3 text-sm leading-6 wrap-anywhere whitespace-pre-wrap text-sand-500 dark:border-sand-700 dark:text-sand-400">
          {text}
        </div>
      )}
    </div>
  );
}

/** 글이 나온 뒤에도 답변이 끝나지 않았다는 걸 보여 주는 돌아가는 표시 (도구를 부르거나 파일 내용을 쓰는 중일 때) */
function WorkingNotice({ running }: { running: boolean }) {
  return (
    <p className="mt-2 inline-flex items-center gap-2 text-sm text-sand-500 dark:text-sand-400" role="status">
      <span className="size-3.5 animate-spin rounded-full border-2 border-sand-300 border-t-clay-500" aria-hidden="true" />
      <span className="thinking-shimmer">{running ? '작업하는 중…' : '이어서 쓰는 중…'}</span>
    </p>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-2 py-1 text-sm text-sand-500 dark:text-sand-400" role="status">
      <span className="size-3.5 animate-spin rounded-full border-2 border-sand-300 border-t-clay-500" aria-hidden="true" />
      <span className="thinking-shimmer">생각하는 중…</span>
    </span>
  );
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  onRegenerate,
  canRegenerate = true,
}: {
  message: UiMessage;
  /** 마지막 답변에만 준다 */
  onRegenerate?(): void;
  canRegenerate?: boolean;
}) {
  const failed = message.status === 'error';
  const model = useModels((s) => modelLabel(s.models, message.model));
  return (
    <div className="group">
      <Reasoning text={message.reasoning} live={false} />
      <ToolSteps steps={message.tools} />
      {message.content && <Markdown text={message.content} />}
      {failed && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          답변을 만들지 못했어요. 잠시 후 다시 보내 주세요.
        </p>
      )}
      {message.status === 'stopped' && <p className="mt-2 text-xs text-sand-500">답변을 중단했어요.</p>}
      {(message.content || model || onRegenerate) && (
        <div className="mt-1 -ml-1.5 flex items-center gap-2">
          {message.content && (
            <CopyButton
              text={message.content}
              label="답변 복사"
              className="text-sand-500 hover:bg-sand-100 hover:text-sand-800 dark:hover:bg-sand-800 dark:hover:text-sand-100"
            />
          )}
          {onRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
              disabled={!canRegenerate}
              title={canRegenerate ? '같은 질문으로 답변을 다시 만들어요' : '다른 답변이 끝난 뒤에 할 수 있어요'}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-sand-500 transition-colors hover:bg-sand-100 hover:text-sand-800 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-sand-800 dark:hover:text-sand-100"
            >
              <RefreshIcon size={14} /> 다시 만들기
            </button>
          )}
          {model && <span className="px-1.5 text-xs text-sand-400 dark:text-sand-500">{model}</span>}
        </div>
      )}
    </div>
  );
});

/** 모델을 메모리에 불러오는 동안의 안내 (경과 시간 표시) */
function LoadingNotice() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
  return (
    <div className="flex items-start gap-2.5 text-sm text-sand-500 dark:text-sand-400" role="status">
      <span className="mt-1.5 size-2 shrink-0 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
      <p>
        모델을 불러오는 중이에요 <span className="tabular-nums">({elapsed})</span>
        <br />
        <span className="text-xs text-sand-400 dark:text-sand-500">
          오래 안 쓴 모델이나 큰 모델은 1~3분 걸릴 수 있어요. 불러오면 바로 답변을 시작해요.
        </span>
      </p>
    </div>
  );
}

/** 지금 만들어지고 있는 답변 */
export function LiveAssistantMessage({
  content,
  reasoning,
  phase,
  queuePosition,
  tools,
  pending,
  deciding,
  onDecide,
}: {
  content: string;
  reasoning: string;
  phase: Phase;
  queuePosition: number;
  tools: ToolStep[];
  pending: ToolRequest | null;
  deciding: boolean;
  onDecide(approve: boolean, switchMode?: PermissionMode): void;
}) {
  const waiting = !content && !reasoning && tools.length === 0 && !pending;
  return (
    <div>
      <Reasoning text={reasoning} live={!content && !pending} />
      <ToolSteps steps={tools} />
      {content && <Markdown text={content} />}
      {pending && <ApprovalCard request={pending} deciding={deciding} onDecide={onDecide} />}
      {!waiting && !pending && phase === 'queued' && (
        <p className="mt-2 text-sm text-sand-500">다른 답변이 끝나길 기다리는 중이에요 (대기 {queuePosition}번째)…</p>
      )}
      {waiting && phase === 'queued' && (
        <p className="text-sm text-sand-500 dark:text-sand-400">
          다른 답변을 만드는 중이라 <b className="font-semibold text-amber-600 dark:text-amber-400">대기 {queuePosition}번째</b>
          예요. 곧 시작할게요.
        </p>
      )}
      {waiting && phase === 'connecting' && <p className="text-sm text-sand-500">연결하는 중…</p>}
      {waiting && phase === 'loading' && <LoadingNotice />}
      {waiting && phase === 'compacting' && (
        <p className="flex items-center gap-2 text-sm text-sand-500 dark:text-sand-400" role="status">
          <span className="size-3 animate-spin rounded-full border-2 border-sand-300 border-t-clay-500" aria-hidden="true" />
          대화가 길어져서 앞부분을 요약해 기억하는 중이에요…
        </p>
      )}
      {waiting && phase !== 'queued' && phase !== 'connecting' && phase !== 'loading' && phase !== 'compacting' && (
        <TypingDots />
      )}
      {!waiting && !pending && (content || tools.length > 0) && (phase === 'thinking' || phase === 'answering') && (
        <WorkingNotice running={tools.length > 0 || !content} />
      )}
      {phase === 'stopping' && <p className="mt-2 text-xs text-sand-500">중단하는 중…</p>}
    </div>
  );
}
