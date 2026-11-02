import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MAX_MESSAGE_CHARS } from "../lib/brand";
import {
  ACCEPT,
  MAX_ATTACHMENTS,
  formatSize,
  type PendingFile,
} from "../lib/upload";
import { formatResetAt, usageRatio, useUsage } from "../store/usage";
import type { LocalFolder } from "../lib/localFolder";
import { FolderPicker } from "./FolderPicker";
import { PermissionPicker } from "./PermissionPicker";
import { useGoogle } from "../store/google";
import { useWebSearch } from "../store/webSearch";
import {
  CloseIcon,
  FileIcon,
  GlobeIcon,
  MailIcon,
  PaperclipIcon,
  SendIcon,
  StopIcon,
} from "./Icons";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { StylePicker } from "./StylePicker";

interface Props {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  /** 이 대화에서 답변을 만드는 중 → 전송 버튼이 중단 버튼이 된다 */
  generating: boolean;
  stopping: boolean;
  onStop(): void;
  /** 다른 대화에서 답변을 만드는 중이라 보낼 수 없음 */
  blockedReason?: string;
  autoFocus?: boolean;
  /** 새 채팅 화면처럼 입력창이 화면 가운데 있으면 메뉴를 아래로 연다 */
  menuPlacement?: "up" | "down";
  /** 아래 안내 문구를 보일지 */
  showHint?: boolean;
  /** AI 가 다룰 내 컴퓨터 폴더 (undefined 면 폴더 고르기를 보이지 않는다) */
  folder?: LocalFolder | null;
  onFolderChange?(folder: LocalFolder | null): void;
  /** 붙여 둔 파일 (undefined 면 첨부 기능을 보이지 않는다) */
  attachments?: PendingFile[];
  onAddFiles?(files: File[]): void;
  onRemoveAttachment?(localId: string): void;
}

/** 붙여 둔 파일 하나 (이미지는 작은 그림, 문서는 이름) */
function AttachmentChip({
  file,
  onRemove,
}: {
  file: PendingFile;
  onRemove(): void;
}) {
  return (
    <div
      className={`group/chip relative flex h-14 max-w-[13rem] items-center gap-2 rounded-xl border px-2 text-xs ${
        file.status === "error"
          ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          : "border-sand-200 bg-sand-50 dark:border-sand-700 dark:bg-sand-900"
      }`}
      title={file.error ?? `${file.name} (${formatSize(file.size)})`}
    >
      {file.preview ? (
        <img
          src={file.preview}
          alt=""
          className="size-10 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sand-200/70 text-sand-500 dark:bg-sand-800">
          <FileIcon size={18} />
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">{file.name}</span>
        <span className="block truncate text-sand-500 dark:text-sand-400">
          {file.status === "uploading"
            ? "올리는 중…"
            : file.status === "error"
              ? file.error
              : formatSize(file.size)}
        </span>
      </span>
      {file.status === "uploading" && (
        <span
          className="absolute top-1 left-1 size-3 animate-spin rounded-full border-2 border-sand-300 border-t-clay-500"
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`${file.name} 빼기`}
        className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-sand-700 text-white opacity-100 md:opacity-0 md:group-hover/chip:opacity-100 dark:bg-sand-300 dark:text-sand-900"
      >
        <CloseIcon size={11} strokeWidth={3} />
      </button>
    </div>
  );
}

/** 5시간 사용량이 80% 를 넘으면 입력창 위에 알려준다 (Claude 처럼) */
function UsageNotice() {
  const usage = useUsage((s) => s.usage);
  if (!usage || usage.limit === 0 || !usage.resetAt) return null;
  const ratio = usageRatio(usage);
  if (ratio < 0.8) return null;
  const full = ratio >= 1;
  return (
    <div
      role="status"
      className={`mx-3 -mb-px rounded-t-xl border border-b-0 px-3.5 py-2 text-xs ${
        full
          ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
          : "border-sand-200 bg-sand-100 text-sand-600 dark:border-sand-700 dark:bg-sand-800 dark:text-sand-300"
      }`}
    >
      {full
        ? `5시간 사용량을 모두 썼어요. ${formatResetAt(usage.resetAt)}에 다시 쓸 수 있어요.`
        : `5시간 사용량의 ${Math.round(ratio * 100)}%를 썼어요 · ${formatResetAt(usage.resetAt)}에 초기화돼요`}
    </div>
  );
}

/** Gmail 켜기/끄기 (Gmail 을 연결한 사람에게만 보인다) */
function GmailToggle({ disabled }: { disabled: boolean }) {
  const connected = useGoogle((s) => s.status?.gmail ?? null);
  const on = useGoogle((s) => s.gmailOn);
  const toggle = useGoogle((s) => s.toggleGmail);
  if (!connected) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      aria-pressed={on}
      aria-label="Gmail"
      title={
        on
          ? `Gmail 켜짐: AI 가 ${connected.email} 의 메일을 찾아 읽을 수 있어요 (누르면 꺼짐)`
          : "Gmail 꺼짐 (누르면 켜짐)"
      }
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors disabled:opacity-50 ${
        on
          ? "bg-clay-50 text-clay-700 hover:bg-clay-100 dark:bg-clay-950/50 dark:text-clay-300 dark:hover:bg-clay-950"
          : "text-sand-600 hover:bg-sand-100 hover:text-sand-900 dark:text-sand-300 dark:hover:bg-sand-700/60 dark:hover:text-sand-50"
      }`}
    >
      <MailIcon size={16} />
      {on && <span>Gmail</span>}
    </button>
  );
}

/** 웹 검색 켜기/끄기 (사이트에 웹 검색이 설정돼 있을 때만 보인다) */
function WebSearchToggle({ disabled }: { disabled: boolean }) {
  const available = useWebSearch((s) => s.available);
  const enabled = useWebSearch((s) => s.enabled);
  const toggle = useWebSearch((s) => s.toggle);
  if (!available) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      aria-pressed={enabled}
      aria-label="웹 검색"
      title={
        enabled
          ? "웹 검색 켜짐: AI 가 필요하면 인터넷을 찾아봐요 (누르면 꺼짐)"
          : "웹 검색 꺼짐 (누르면 켜짐)"
      }
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors disabled:opacity-50 ${
        enabled
          ? "bg-clay-50 text-clay-700 hover:bg-clay-100 dark:bg-clay-950/50 dark:text-clay-300 dark:hover:bg-clay-950"
          : "text-sand-600 hover:bg-sand-100 hover:text-sand-900 dark:text-sand-300 dark:hover:bg-sand-700/60 dark:hover:text-sand-50"
      }`}
    >
      <GlobeIcon size={16} />
      {enabled && <span>웹 검색</span>}
    </button>
  );
}

export function Composer({
  value,
  onChange,
  onSubmit,
  generating,
  stopping,
  onStop,
  blockedReason,
  autoFocus,
  menuPlacement = "up",
  showHint = true,
  folder,
  onFolderChange,
  attachments,
  onAddFiles,
  onRemoveAttachment,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const canAttach = !!attachments && !!onAddFiles;
  const uploading = attachments?.some((a) => a.status === "uploading") ?? false;
  const readyFiles =
    attachments?.filter((a) => a.status === "ready").length ?? 0;

  // 내용에 맞춰 높이 조절 (최대 320px)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // 글이나 다 올린 파일이 있어야 보낼 수 있다 (올리는 중이면 기다린다)
  const canSend =
    (value.trim().length > 0 || readyFiles > 0) &&
    !uploading &&
    !generating &&
    !blockedReason;

  const addFiles = (list: FileList | File[] | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length && canAttach) onAddFiles!(files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중(IME)에 누른 Enter 는 전송이 아니라 글자 확정이다
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      if (canSend) onSubmit();
    }
  };

  return (
    <div>
      <UsageNotice />
      <div
        className={`relative rounded-2xl border bg-white shadow-[0_2px_12px_-4px] shadow-sand-900/10 transition-colors focus-within:border-sand-400 dark:bg-sand-800 dark:shadow-black/30 dark:focus-within:border-sand-600 ${
          dragging
            ? "border-clay-500 ring-2 ring-clay-500/30"
            : "border-sand-300/80 dark:border-sand-700"
        }`}
        onClick={(e) => {
          // 카드의 빈 곳을 눌러도 입력칸에 커서가 가게
          if (e.target === e.currentTarget) ref.current?.focus();
        }}
        // 파일을 끌어다 놓으면 붙인다
        onDragOver={(e) => {
          if (!canAttach || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(e) => {
          if (!canAttach) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-clay-50/90 text-sm font-medium text-clay-700 dark:bg-clay-950/80 dark:text-clay-300">
            여기에 놓으면 파일을 붙여요
          </div>
        )}
        {attachments && attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.localId}
                file={a}
                onRemove={() => onRemoveAttachment?.(a.localId)}
              />
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={value}
          maxLength={MAX_MESSAGE_CHARS}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          // 스크린샷 등 그림을 붙여 넣으면 파일로 붙인다
          onPaste={(e) => {
            if (!canAttach) return;
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          placeholder={blockedReason ?? "무엇이든 물어보세요"}
          aria-label="메시지 입력"
          className="block max-h-[320px] min-h-[4.5rem] w-full resize-none bg-transparent px-5 pt-4 pb-2 text-base leading-7 outline-none placeholder:text-sand-400 dark:placeholder:text-sand-500"
        />
        <div className="flex items-end gap-2 px-3 pt-1 pb-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1">
            {canAttach && (
              <>
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={(attachments?.length ?? 0) >= MAX_ATTACHMENTS}
                  aria-label="파일 붙이기"
                  title={`파일 붙이기 (이미지·PDF·워드·텍스트, 최대 ${MAX_ATTACHMENTS}개) — 끌어다 놓거나 붙여 넣어도 돼요`}
                  className="rounded-lg p-1.5 text-sand-600 transition-colors hover:bg-sand-100 hover:text-sand-900 disabled:opacity-40 dark:text-sand-300 dark:hover:bg-sand-700/60 dark:hover:text-sand-50"
                >
                  <PaperclipIcon size={17} />
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = ""; // 같은 파일을 다시 고를 수 있게
                  }}
                />
              </>
            )}
            <StylePicker placement={menuPlacement} />
            {folder !== undefined && onFolderChange && (
              <FolderPicker
                value={folder}
                onChange={onFolderChange}
                disabled={generating}
                placement={menuPlacement}
              />
            )}
            {folder && <PermissionPicker placement={menuPlacement} />}
            <WebSearchToggle disabled={generating} />
            <GmailToggle disabled={generating} />
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            <EffortPicker placement={menuPlacement} />
            <ModelPicker placement={menuPlacement} />
            {generating ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                aria-label="답변 중단"
                title="답변 중단"
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-sand-900 text-white transition-opacity hover:opacity-80 disabled:opacity-40 dark:bg-sand-100 dark:text-sand-900"
              >
                <StopIcon size={14} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => canSend && onSubmit()}
                disabled={!canSend}
                aria-label="전송"
                title="전송 (Enter)"
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-clay-500 text-white transition-colors hover:bg-clay-600 disabled:bg-clay-300 disabled:text-white/90 dark:disabled:bg-clay-900 dark:disabled:text-clay-300/60"
              >
                <SendIcon size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
      {showHint && (
        <p className="mt-2 text-center text-xs text-sand-400 dark:text-sand-500">
          AI 는 실수할 수 있어요. 중요한 내용은 다시 확인해 주세요.
        </p>
      )}
    </div>
  );
}
