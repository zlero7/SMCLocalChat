import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useMatch, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { APP_NAME } from '../lib/brand';
import { groupConversations } from '../lib/time';
import type { Conversation } from '../lib/types';
import { useAuth } from '../store/auth';
import { useChats } from '../store/chats';
import { useTheme } from '../store/theme';
import {
  ClockIcon,
  LogoutIcon,
  MonitorIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  SparkIcon,
  SunIcon,
  CloseIcon,
  ProjectIcon,
  SearchIcon,
  TrashIcon,
} from './Icons';

function ConversationItem({ conv, active }: { conv: Conversation; active: boolean }) {
  const rename = useChats((s) => s.rename);
  const remove = useChats((s) => s.remove);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conv.title);
  const cancelled = useRef(false);

  const commit = async () => {
    if (cancelled.current) return;
    const title = draft.trim();
    setEditing(false);
    if (title && title !== conv.title) {
      try {
        await rename(conv.id, title);
      } catch {
        /* 실패하면 원래 제목이 그대로 보인다 */
      }
    }
  };

  const onDelete = async () => {
    if (!window.confirm(`"${conv.title}" 대화를 삭제할까요?`)) return;
    try {
      await remove(conv.id);
      if (active) navigate('/chat');
    } catch {
      window.alert('삭제하지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={100}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            cancelled.current = true;
            setEditing(false);
          }
        }}
        aria-label="대화 이름"
        className="w-full rounded-lg border border-clay-500 bg-white px-2.5 py-2 text-sm outline-none dark:bg-sand-900"
      />
    );
  }

  return (
    <div className="group relative">
      <NavLink
        to={`/chat/${conv.id}`}
        className={`block truncate rounded-lg py-2 pr-16 pl-2.5 text-sm transition-colors ${
          active
            ? 'bg-sand-200/80 font-medium dark:bg-sand-800'
            : 'text-sand-700 hover:bg-sand-200/50 dark:text-sand-300 dark:hover:bg-sand-800/60'
        }`}
        title={conv.scheduled ? `예약 작업 결과: ${conv.title}` : conv.title}
      >
        <span className="flex items-center gap-1.5">
          {conv.scheduled && <ClockIcon size={13} className="shrink-0 text-sand-400" />}
          <span className={`truncate ${conv.unread ? 'font-semibold text-sand-900 dark:text-sand-50' : ''}`}>{conv.title}</span>
          {conv.unread && <span className="size-2 shrink-0 rounded-full bg-clay-500" aria-label="새 결과" />}
        </span>
      </NavLink>
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center opacity-100 focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
        <button
          type="button"
          onClick={() => {
            cancelled.current = false;
            setDraft(conv.title);
            setEditing(true);
          }}
          aria-label="이름 변경"
          title="이름 변경"
          className="rounded-md p-1.5 text-sand-500 hover:bg-sand-300/60 hover:text-sand-900 dark:hover:bg-sand-700 dark:hover:text-sand-100"
        >
          <PencilIcon size={15} />
        </button>
        <button
          type="button"
          onClick={() => void onDelete()}
          aria-label="삭제"
          title="삭제"
          className="rounded-md p-1.5 text-sand-500 hover:bg-sand-300/60 hover:text-red-600 dark:hover:bg-sand-700 dark:hover:text-red-400"
        >
          <TrashIcon size={15} />
        </button>
      </div>
    </div>
  );
}

interface SearchHit {
  conversation: Conversation;
  snippet: string | null;
}

/** 검색어 부분을 굵게 */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (!query || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-clay-100 px-0.5 text-inherit dark:bg-clay-900/60">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** 대화 검색: 제목과 내용에서 찾는다 (입력을 멈추고 0.3초 뒤에 찾음) */
function SearchPanel({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ items: SearchHit[] }>(`/conversations/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((data) => {
          setHits(data.items);
          setError(null);
        })
        .catch((err) => {
          if ((err as Error).name !== 'AbortError') setError('검색하지 못했어요.');
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const q = query.trim();
  return (
    <div className="px-3 pb-3">
      <div className="relative">
        <SearchIcon size={15} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-sand-400" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
          placeholder="제목이나 내용으로 찾기"
          aria-label="대화 검색"
          className="w-full rounded-lg border border-sand-300 bg-white py-2 pr-8 pl-8 text-sm outline-none focus:border-clay-500 dark:border-sand-700 dark:bg-sand-900"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="검색 닫기"
          title="검색 닫기 (Esc)"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-sand-400 hover:text-sand-800 dark:hover:text-sand-100"
        >
          <CloseIcon size={14} />
        </button>
      </div>
      {error && <p className="px-1 pt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {q && hits?.length === 0 && <p className="px-1 pt-3 text-sm text-sand-500">"{q}" 이(가) 들어간 대화가 없어요.</p>}
      {hits && hits.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {hits.map(({ conversation: c, snippet }) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => navigate(`/chat/${c.id}`)}
                className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-sand-200/50 dark:hover:bg-sand-800/60"
              >
                <span className="block truncate text-sm font-medium">
                  <Highlight text={c.title} query={q} />
                </span>
                {snippet && (
                  <span className="mt-0.5 line-clamp-2 text-xs text-sand-500 dark:text-sand-400">
                    <Highlight text={snippet} query={q} />
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Sidebar() {
  const items = useChats((s) => s.items);
  const nextCursor = useChats((s) => s.nextCursor);
  const loading = useChats((s) => s.loading);
  const loaded = useChats((s) => s.loaded);
  const load = useChats((s) => s.load);
  const loadMore = useChats((s) => s.loadMore);
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = useTheme((s) => s.theme);
  const cycleTheme = useTheme((s) => s.cycle);
  const navigate = useNavigate();
  const activeId = useMatch('/chat/:id')?.params.id;
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupConversations(items), [items]);

  const ThemeIcon = theme === 'dark' ? MoonIcon : theme === 'light' ? SunIcon : MonitorIcon;
  const themeLabel = theme === 'dark' ? '다크' : theme === 'light' ? '라이트' : '시스템';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <SparkIcon size={20} className="text-clay-500" />
        <span className="text-[17px] font-semibold tracking-tight">{APP_NAME}</span>
      </div>

      <div className="space-y-0.5 px-3 pb-2">
        <button
          type="button"
          onClick={() => navigate('/chat')}
          className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm font-medium text-clay-700 transition-colors hover:bg-sand-200/60 dark:text-clay-300 dark:hover:bg-sand-800"
        >
          <span className="grid size-6 place-items-center rounded-full bg-clay-500 text-white transition-transform group-hover:scale-105">
            <PlusIcon size={15} strokeWidth={2.5} />
          </span>
          새 채팅
        </button>
        <button
          type="button"
          onClick={() => setSearching((s) => !s)}
          aria-pressed={searching}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors ${
            searching
              ? 'bg-sand-200/80 font-medium dark:bg-sand-800'
              : 'text-sand-700 hover:bg-sand-200/60 dark:text-sand-300 dark:hover:bg-sand-800'
          }`}
        >
          <span className="grid size-6 place-items-center text-sand-500">
            <SearchIcon size={17} />
          </span>
          대화 검색
        </button>
        <NavLink
          to="/projects"
          className={({ isActive }) =>
            `flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors ${
              isActive
                ? 'bg-sand-200/80 font-medium dark:bg-sand-800'
                : 'text-sand-700 hover:bg-sand-200/60 dark:text-sand-300 dark:hover:bg-sand-800'
            }`
          }
        >
          <span className="grid size-6 place-items-center text-sand-500">
            <ProjectIcon size={17} />
          </span>
          프로젝트
        </NavLink>
        <NavLink
          to="/schedules"
          className={({ isActive }) =>
            `flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors ${
              isActive
                ? 'bg-sand-200/80 font-medium dark:bg-sand-800'
                : 'text-sand-700 hover:bg-sand-200/60 dark:text-sand-300 dark:hover:bg-sand-800'
            }`
          }
        >
          <span className="grid size-6 place-items-center text-sand-500">
            <ClockIcon size={17} />
          </span>
          예약 작업
        </NavLink>
        {user?.role === 'admin' && (
          <NavLink
            to="/admin"
            className={({ isActive }) =>
              `flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-sand-200/80 font-medium dark:bg-sand-800'
                  : 'text-sand-700 hover:bg-sand-200/60 dark:text-sand-300 dark:hover:bg-sand-800'
              }`
            }
          >
            <span className="grid size-6 place-items-center text-sand-500">
              <ShieldIcon size={17} />
            </span>
            관리자
          </NavLink>
        )}
      </div>

      {searching && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SearchPanel onClose={() => setSearching(false)} />
        </div>
      )}
      <nav className={`min-h-0 flex-1 overflow-y-auto px-3 pb-3 ${searching ? 'hidden' : ''}`} aria-label="대화 목록">
        {!loaded && loading && <p className="px-2.5 py-3 text-sm text-sand-500">불러오는 중…</p>}
        {loaded && items.length === 0 && (
          <p className="px-2.5 py-3 text-sm text-sand-500">아직 대화가 없어요. 첫 질문을 해 보세요!</p>
        )}
        {groups.map((group) => (
          <div key={group.label} className="mt-3 first:mt-1">
            <h2 className="px-2.5 pb-1 text-xs font-medium text-sand-500">{group.label}</h2>
            <div className="space-y-0.5">
              {group.items.map((c) => (
                <ConversationItem key={c.id} conv={c} active={c.id === activeId} />
              ))}
            </div>
          </div>
        ))}
        {nextCursor && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="mt-3 w-full rounded-lg py-2 text-sm text-sand-500 hover:bg-sand-200/50 disabled:opacity-50 dark:hover:bg-sand-800/60"
          >
            {loading ? '불러오는 중…' : '더 보기'}
          </button>
        )}
      </nav>

      <div className="flex items-center gap-1 border-t border-sand-200 p-2 dark:border-sand-800">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors ${
              isActive ? 'bg-sand-200/80 dark:bg-sand-800' : 'hover:bg-sand-200/50 dark:hover:bg-sand-800/60'
            }`
          }
          title="설정"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sand-800 text-sm font-semibold text-sand-50 dark:bg-sand-200 dark:text-sand-900">
            {user?.nickname.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{user?.nickname}</span>
            <span className="flex items-center gap-1 text-xs text-sand-500">
              <SettingsIcon size={11} /> 설정
            </span>
          </span>
        </NavLink>
        <button
          type="button"
          onClick={cycleTheme}
          aria-label={`테마: ${themeLabel} (누르면 바뀜)`}
          title={`테마: ${themeLabel}`}
          className="rounded-lg p-2 text-sand-500 hover:bg-sand-200/60 hover:text-sand-900 dark:hover:bg-sand-800 dark:hover:text-sand-100"
        >
          <ThemeIcon size={18} />
        </button>
        <button
          type="button"
          onClick={() => void logout()}
          aria-label="로그아웃"
          title="로그아웃"
          className="rounded-lg p-2 text-sand-500 hover:bg-sand-200/60 hover:text-sand-900 dark:hover:bg-sand-800 dark:hover:text-sand-100"
        >
          <LogoutIcon size={18} />
        </button>
      </div>
    </div>
  );
}
