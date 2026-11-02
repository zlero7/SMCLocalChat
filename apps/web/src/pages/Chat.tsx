import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Composer } from '../components/Composer';
import { ProjectIcon, SparkIcon } from '../components/Icons';
import { MemoryNotice } from '../components/MemoryNotice';
import { AssistantMessage, LiveAssistantMessage, UserMessage, type UiMessage } from '../components/MessageView';
import { ApiError, api, errorMessage } from '../lib/api';
import { SUGGESTIONS } from '../lib/brand';
import type { Attachment, Conversation, ConversationDetail, ServerMessage } from '../lib/types';
import { MAX_ATTACHMENTS, newPendingFile, uploadFile, type PendingFile } from '../lib/upload';
import { useAuth } from '../store/auth';
import { useChats } from '../store/chats';
import { useProjects } from '../store/projects';
import { currentModel, useModels } from '../store/models';
import { usageBlockReason, useUsage } from '../store/usage';
import {
  ensurePermission,
  loadConversationFolder,
  saveConversationFolder,
  type LocalFolder,
} from '../lib/localFolder';
import { useStream } from '../store/stream';

/** 시간대에 맞는 인사말 (Claude 의 "Good evening" 처럼) */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return '늦은 밤이에요';
  if (h < 11) return '좋은 아침이에요';
  if (h < 17) return '좋은 오후예요';
  if (h < 22) return '좋은 저녁이에요';
  return '편안한 밤이에요';
}

// 새 채팅에서 첫 메시지를 보낸 뒤 이동한 화면이 같은 메시지를 두 번 보내지 않도록 기록
const consumedPending = new Set<string>();

const toUi = (m: ServerMessage): UiMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  reasoning: m.reasoning,
  status: m.status,
  model: m.model,
  tools: m.tools ?? [],
  attachments: m.attachments ?? [],
});

/** 새 채팅에서 첫 메시지를 보낼 때 대화 화면으로 넘기는 것 */
interface PendingSend {
  pending?: string;
  attachments?: Attachment[];
}

export default function ChatPage() {
  const { id } = useParams();
  // 새 채팅 주소에 ?project=… 가 있으면 그 프로젝트 안에서 대화를 시작한다
  const [params] = useSearchParams();
  const projectId = id ? null : params.get('project');
  // 대화가 바뀌면 화면 상태를 통째로 새로 시작한다
  return <ChatView key={id ?? `new-${projectId ?? ''}`} id={id} newProjectId={projectId} />;
}

function ChatView({ id, newProjectId }: { id?: string; newProjectId: string | null }) {
  const newProject = useProjects((s) => (newProjectId ? s.items.find((p) => p.id === newProjectId) : undefined));
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuth((s) => s.user);
  const globalStream = useStream((s) => s.stream);

  const [messages, setMessages] = useState<UiMessage[]>([]);
  // 대화가 길어서 이 메시지까지는 요약해서 기억한다 (그 아래에 안내 줄을 긋는다)
  const [summarizedThrough, setSummarizedThrough] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // AI 가 다룰 내 컴퓨터 폴더 (null = 일반 대화). 대화마다 이 브라우저에 기억해 둔다
  const [folder, setFolder] = useState<LocalFolder | null>(null);
  const folderRef = useRef<LocalFolder | null>(null);
  folderRef.current = folder;

  const lastText = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // 5시간 사용량을 다 썼으면 보내기 전에 막는다 (서버도 429 로 거절한다)
  const usageBlocked = useUsage((s) => usageBlockReason(s.usage));

  const live = globalStream && globalStream.convId === id ? globalStream : null;
  const generatingHere = !!live && live.phase !== 'finished';
  const busyElsewhere = !!globalStream && globalStream.phase !== 'finished' && globalStream.convId !== id;

  // 마지막 요청이 새 메시지였는지 (거절되면 보낸 글을 입력창으로 되돌려 줄지 정한다)
  const lastWasNew = useRef(true);

  const tmpUser = (text: string, attachments: Attachment[] = []): UiMessage => ({
    id: `tmp-${Date.now()}`,
    role: 'user',
    content: text || (attachments.length ? '첨부한 파일을 살펴봐 주세요.' : ''),
    reasoning: '',
    status: 'done',
    model: null,
    tools: [],
    attachments,
  });

  const send = useCallback((text: string, convId: string, useFolder: LocalFolder | null, attachments: Attachment[] = []) => {
    lastText.current = text;
    lastWasNew.current = true;
    stick.current = true;
    setError(null);
    setMessages((m) => [...m, tmpUser(text, attachments)]);
    useStream.getState().start(
      convId,
      {
        content: text,
        model: currentModel(useModels.getState()),
        attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined,
      },
      useFolder,
    );
  }, []);

  // ── 첨부 파일 ──
  const [files, setFiles] = useState<PendingFile[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const patchFile = (localId: string, patch: Partial<PendingFile>) =>
    setFiles((list) => list.map((f) => (f.localId === localId ? { ...f, ...patch } : f)));

  const addFiles = (picked: File[]) => {
    const room = MAX_ATTACHMENTS - filesRef.current.length;
    if (picked.length > room) setError(`파일은 한 번에 ${MAX_ATTACHMENTS}개까지 붙일 수 있어요.`);
    for (const file of picked.slice(0, Math.max(0, room))) {
      const pending = newPendingFile(file);
      setFiles((list) => [...list, pending]);
      uploadFile(file)
        .then((attachment) => patchFile(pending.localId, { status: 'ready', attachment, size: attachment.size }))
        .catch((err) => patchFile(pending.localId, { status: 'error', error: errorMessage(err) }));
    }
  };

  const removeFile = (localId: string) => {
    const f = filesRef.current.find((x) => x.localId === localId);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    // 올려 둔 파일도 지운다 (보내지 않았으니 남길 이유가 없다)
    if (f?.attachment) void api(`/files/${f.attachment.id}`, { method: 'DELETE' }).catch(() => {});
    setFiles((list) => list.filter((x) => x.localId !== localId));
  };

  /** 보낸 뒤 입력창의 첨부를 비운다 (파일은 메시지에 붙었으니 지우지 않는다) */
  const clearFiles = () => {
    for (const f of filesRef.current) if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles([]);
  };

  // 대화 불러오기 (+ 새 채팅에서 넘어온 첫 메시지 보내기)
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const [data, savedFolder] = await Promise.all([
          api<ConversationDetail>(`/conversations/${id}`),
          loadConversationFolder(id),
        ]);
        if (cancelled) return;
        setMessages(data.messages.map(toUi));
        setSummarizedThrough(data.summarizedThrough ?? null);
        setFolder(savedFolder);
        setLoading(false);
        const state = location.state as PendingSend | null;
        if ((state?.pending || state?.attachments?.length) && !consumedPending.has(location.key)) {
          consumedPending.add(location.key);
          navigate(location.pathname, { replace: true, state: null });
          send(state.pending ?? '', id, savedFolder, state.attachments ?? []);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          navigate('/chat', { replace: true });
        } else {
          setLoadError(errorMessage(err, '대화를 불러오지 못했어요.'));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 답변 생성이 끝나면 서버에 저장된 최종 내용으로 교체한다
  useEffect(() => {
    if (!id || !live || live.phase !== 'finished') return;
    if (live.rejected) {
      setError(live.error ?? '메시지를 보내지 못했어요.');
      useStream.getState().clear();
      if (lastWasNew.current) {
        // 서버가 요청을 받아주지 않았다 → 보낸 글을 입력창으로 되돌려 준다
        setMessages((m) => m.filter((x, i) => !(i === m.length - 1 && x.id.startsWith('tmp-'))));
        setDraft((d) => d || lastText.current);
      } else {
        // 다시 만들기·고치기가 거절됐으면 서버에는 아무것도 바뀌지 않았으니 원래 대화를 다시 불러온다
        void api<ConversationDetail>(`/conversations/${id}`)
          .then((data) => {
            setMessages(data.messages.map(toUi));
            setSummarizedThrough(data.summarizedThrough ?? null);
          })
          .catch(() => {});
      }
      return;
    }
    if (live.error) setError(live.error);
    void (async () => {
      try {
        const data = await api<ConversationDetail>(`/conversations/${id}`);
        setMessages(data.messages.map(toUi));
        setSummarizedThrough(data.summarizedThrough ?? null);
      } catch {
        /* 화면에 있는 내용을 그대로 둔다 */
      }
      useStream.getState().clear();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, live?.token, live?.phase]);

  // 새 내용이 오면 맨 아래로 (사용자가 위로 스크롤해 읽는 중이면 따라가지 않는다)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, live?.content, live?.reasoning, live?.phase, loading]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const changeFolder = (next: LocalFolder | null) => {
    setFolder(next);
    if (id) void saveConversationFolder(id, next);
  };

  const submitText = async (raw: string) => {
    const text = raw.trim();
    const ready = files.filter((f) => f.status === 'ready' && f.attachment).map((f) => f.attachment!);
    if ((!text && ready.length === 0) || generatingHere || busyElsewhere) return;
    if (files.some((f) => f.status === 'uploading')) {
      setError('파일을 올리는 중이에요. 다 올라간 뒤에 보내 주세요.');
      return;
    }
    if (usageBlocked) {
      setError(usageBlocked); // 입력한 글은 그대로 둔다
      return;
    }
    // 폴더 권한은 페이지를 새로 열면 다시 물어야 할 수 있다 (보내기를 누른 지금이 물을 수 있는 때)
    if (folder && !(await ensurePermission(folder, true).catch(() => false))) {
      setError(`"${folder.name}" 폴더 권한이 없어요. 📁 버튼에서 폴더를 다시 열거나 "폴더 없이 대화"를 골라 주세요.`);
      return;
    }
    setDraft('');
    setError(null);
    // 실패한 파일은 빼고, 다 올린 파일만 함께 보낸다
    clearFiles();
    if (!id) {
      try {
        const { conversation } = await api<{ conversation: Conversation }>('/conversations', {
          method: 'POST',
          body: newProjectId ? { projectId: newProjectId } : {},
        });
        await saveConversationFolder(conversation.id, folder); // 새 화면이 이 폴더를 불러와서 첫 메시지와 함께 쓴다
        useChats.getState().upsert(conversation);
        const state: PendingSend = { pending: text, attachments: ready };
        navigate(`/chat/${conversation.id}`, { state });
      } catch (err) {
        setDraft(text);
        setError(errorMessage(err));
      }
      return;
    }
    send(text, id, folder, ready);
  };

  /** 보내기 전에 막아야 하는 이유 (없으면 null) */
  const blockReason = async (): Promise<string | null> => {
    if (generatingHere || busyElsewhere) return '다른 답변이 끝난 뒤에 할 수 있어요.';
    if (usageBlocked) return usageBlocked;
    if (folder && !(await ensurePermission(folder, true).catch(() => false))) {
      return `"${folder.name}" 폴더 권한이 없어요. 📁 버튼에서 폴더를 다시 열거나 "폴더 없이 대화"를 골라 주세요.`;
    }
    return null;
  };

  /** 마지막 답변을 지우고 같은 질문으로 다시 만든다 */
  const regenerate = async () => {
    if (!id) return;
    const reason = await blockReason();
    if (reason) return setError(reason);
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    if (lastUser < 0) return;
    lastWasNew.current = false;
    stick.current = true;
    setError(null);
    setMessages((m) => m.slice(0, lastUser + 1));
    useStream.getState().start(id, { regenerate: true, model: currentModel(useModels.getState()) }, folder);
  };

  /** 이 메시지를 고쳐서 다시 보낸다 (그 뒤의 대화는 지워진다) */
  const editMessage = async (messageId: string, text: string) => {
    if (!id) return;
    const reason = await blockReason();
    if (reason) return setError(reason);
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    // 고친 메시지에도 원래 붙였던 파일을 그대로 붙인다
    const kept = messages[index]!.attachments ?? [];
    lastWasNew.current = false;
    lastText.current = text;
    stick.current = true;
    setError(null);
    setMessages((m) => [...m.slice(0, index), tmpUser(text, kept)]);
    useStream.getState().start(
      id,
      {
        content: text,
        editMessageId: messageId,
        model: currentModel(useModels.getState()),
        attachmentIds: kept.length ? kept.map((a) => a.id) : undefined,
      },
      folder,
    );
  };

  const showLive = !!live && !(live.phase === 'finished' && !live.content && !live.reasoning);
  const canChange = !generatingHere && !busyElsewhere;
  const lastIndex = messages.length - 1;
  const isEmpty = !loading && !loadError && messages.length === 0 && !showLive;

  const errorBox = error && (
    <div
      role="alert"
      className="mb-2 flex items-start justify-between gap-3 rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
    >
      <span>{error}</span>
      <button type="button" onClick={() => setError(null)} className="shrink-0 underline">
        닫기
      </button>
    </div>
  );

  const composer = (centered: boolean) => (
    <Composer
      value={draft}
      onChange={setDraft}
      onSubmit={() => void submitText(draft)}
      generating={generatingHere}
      stopping={live?.phase === 'stopping'}
      onStop={() => void useStream.getState().stop()}
      blockedReason={
        busyElsewhere ? '다른 대화에서 답변을 만드는 중이에요. 끝나면 보낼 수 있어요.' : (usageBlocked ?? undefined)
      }
      autoFocus={!id}
      menuPlacement={centered ? 'down' : 'up'}
      folder={folder}
      onFolderChange={changeFolder}
      attachments={files}
      onAddFiles={addFiles}
      onRemoveAttachment={removeFile}
      showHint={!centered}
    />
  );

  // 새 채팅: Claude 처럼 인사말과 입력창을 화면 가운데에
  if (isEmpty) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-4 pt-6 pb-[12vh]">
          <h2 className="mb-7 flex items-center justify-center gap-3 text-center text-[26px] font-medium tracking-tight text-sand-800 sm:text-[32px] dark:text-sand-100">
            <SparkIcon size={30} className="shrink-0 text-clay-500" />
            <span>
              {greeting()}, {user?.nickname}님
            </span>
          </h2>
          {errorBox}
          {newProjectId && (
            <div className="mb-2 flex items-center gap-2 text-sm text-sand-600 dark:text-sand-300">
              <ProjectIcon size={15} className="text-clay-500" />
              <span>
                <Link to={`/projects/${newProjectId}`} className="font-medium hover:underline">
                  {newProject?.name ?? '프로젝트'}
                </Link>{' '}
                안의 새 대화예요. 프로젝트 지침과 자료를 함께 써요.
              </span>
              <Link to="/chat" className="ml-auto text-xs text-sand-400 hover:text-sand-700 dark:hover:text-sand-100">
                프로젝트 밖에서 대화하기
              </Link>
            </div>
          )}
          {composer(true)}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.text}
                type="button"
                onClick={() => void submitText(s.text)}
                disabled={busyElsewhere || !!usageBlocked}
                title={s.text}
                className="rounded-lg border border-sand-200 bg-sand-50 px-3 py-1.5 text-sm text-sand-600 transition-colors hover:border-sand-300 hover:bg-white hover:text-sand-900 disabled:opacity-50 dark:border-sand-700 dark:bg-sand-900 dark:text-sand-300 dark:hover:bg-sand-800 dark:hover:text-sand-50"
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6">
          {loading && (
            <div className="space-y-6" aria-busy="true" aria-label="불러오는 중">
              <div className="ml-auto h-10 w-2/5 animate-pulse rounded-2xl bg-sand-100 dark:bg-sand-800" />
              <div className="space-y-2">
                <div className="h-4 w-full animate-pulse rounded bg-sand-100 dark:bg-sand-800" />
                <div className="h-4 w-5/6 animate-pulse rounded bg-sand-100 dark:bg-sand-800" />
                <div className="h-4 w-2/3 animate-pulse rounded bg-sand-100 dark:bg-sand-800" />
              </div>
            </div>
          )}

          {loadError && (
            <div className="m-auto text-center">
              <p className="mb-3 text-sm text-sand-600 dark:text-sand-400">{loadError}</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg border border-sand-300 px-3 py-1.5 text-sm hover:bg-sand-100 dark:border-sand-700 dark:hover:bg-sand-800"
              >
                다시 불러오기
              </button>
            </div>
          )}

          {!loading && !loadError && (messages.length > 0 || showLive) && (
            <div className="space-y-7">
              {messages.map((m, i) => (
                <Fragment key={m.id}>
                  {m.role === 'user' ? (
                    <UserMessage
                      content={m.content}
                      attachments={m.attachments}
                      // 아직 서버에 저장되기 전(tmp-)인 메시지는 고칠 수 없다
                      onEdit={m.id.startsWith('tmp-') ? undefined : (text) => void editMessage(m.id, text)}
                      canEdit={canChange}
                    />
                  ) : (
                    <AssistantMessage
                      message={m}
                      onRegenerate={i === lastIndex && !showLive ? () => void regenerate() : undefined}
                      canRegenerate={canChange}
                    />
                  )}
                  {m.id === summarizedThrough && i < lastIndex && (
                    <div className="flex items-center gap-3 text-xs text-sand-400 dark:text-sand-500" role="separator">
                      <span className="h-px flex-1 bg-sand-200 dark:bg-sand-800" />
                      대화가 길어서 여기까지는 요약해서 기억하고 있어요
                      <span className="h-px flex-1 bg-sand-200 dark:bg-sand-800" />
                    </div>
                  )}
                </Fragment>
              ))}
              {showLive && live && (
                <LiveAssistantMessage
                  content={live.content}
                  reasoning={live.reasoning}
                  phase={live.phase}
                  queuePosition={live.queuePosition}
                  tools={live.tools}
                  pending={live.pending}
                  deciding={live.deciding}
                  onDecide={(approve, mode) => void useStream.getState().decide(approve, mode)}
                />
              )}
              {id && !showLive && <MemoryNotice convId={id} />}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-4 pt-2 pb-3 print:hidden">
        <div className="mx-auto w-full max-w-3xl">
          {errorBox}
          {composer(false)}
        </div>
      </div>
    </div>
  );
}
