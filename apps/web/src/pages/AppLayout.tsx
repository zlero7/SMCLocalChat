import { useEffect, useState } from 'react';
import { Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { ConversationActions } from '../components/ConversationActions';
import { MenuIcon } from '../components/Icons';
import { Sidebar } from '../components/Sidebar';
import { StatusDot } from '../components/StatusDot';
import { APP_NAME } from '../lib/brand';
import { useChats } from '../store/chats';
import { useGoogle } from '../store/google';
import { useProjects } from '../store/projects';
import { useUsage } from '../store/usage';

/** 예약 작업 결과가 나왔다고 브라우저 알림을 띄운다 (사용자가 알림을 허용했을 때만) */
function notifyResult(id: string, title: string, open: (id: string) => void) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`예약 작업 결과: ${title}`, { body: '눌러서 결과를 확인하세요.', tag: id });
    n.onclick = () => {
      window.focus();
      open(id);
      n.close();
    };
  } catch {
    /* 알림을 못 띄워도 사이드바에는 표시된다 */
  }
}

export default function AppLayout() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const activeId = useMatch('/chat/:id')?.params.id;
  const title = useChats((s) => (activeId ? s.items.find((i) => i.id === activeId)?.title : undefined));

  // 5시간 사용량 (입력창 위 알림용), 프로젝트 목록 (대화 위에 프로젝트 이름을 보여 주려고)
  useEffect(() => {
    void useUsage.getState().refresh();
    void useProjects.getState().load();
    void useGoogle.getState().load();
  }, []);

  // 모바일에서 이동하면 사이드바를 닫는다
  useEffect(() => setOpen(false), [location.pathname]);

  // 연 대화는 새 결과 표시를 끈다
  useEffect(() => {
    if (activeId) useChats.getState().markRead(activeId);
  }, [activeId]);

  // 예약 작업 결과: 1분마다(그리고 창으로 돌아올 때) 목록을 새로 받아, 새 결과가 생기면 알린다
  const navigate = useNavigate();
  useEffect(() => {
    const check = async () => {
      const added = await useChats.getState().refresh();
      for (const c of added) {
        if (c.scheduled && c.unread) notifyResult(c.id, c.title, (id) => navigate(`/chat/${id}`));
      }
    };
    const timer = setInterval(() => void check(), 60_000);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [navigate]);

  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {open && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" />
      )}
      <aside data-print="hide"
        className={`fixed inset-y-0 left-0 z-40 w-72 shrink-0 transform border-r border-sand-200 bg-sand-100 transition-transform md:static md:translate-x-0 dark:border-sand-800 dark:bg-sand-950 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="메뉴 열기"
            className="rounded-lg p-2 text-sand-600 hover:bg-sand-100 md:hidden dark:text-sand-300 dark:hover:bg-sand-800"
          >
            <MenuIcon />
          </button>
          <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-sand-700 dark:text-sand-200">
            {title ?? ''}
          </h1>
          {activeId && <ConversationActions id={activeId} />}
          <span className="print:hidden">
            <StatusDot />
          </span>
        </header>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
