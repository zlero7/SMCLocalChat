import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './store/auth';
import Admin from './pages/Admin';
import AppLayout from './pages/AppLayout';
import ChatPage from './pages/Chat';
import Login from './pages/Login';
import { Privacy, Terms } from './pages/Legal';
import ProjectDetail from './pages/ProjectDetail';
import Projects from './pages/Projects';
import Register from './pages/Register';
import ResetPassword from './pages/ResetPassword';
import Schedules from './pages/Schedules';
import SharedConversation from './pages/SharedConversation';
import Settings from './pages/Settings';

function RequireAuth() {
  const user = useAuth((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** 관리자만 (서버도 따로 확인한다) */
function RequireAdmin() {
  const role = useAuth((s) => s.user?.role);
  if (role !== 'admin') return <Navigate to="/chat" replace />;
  return <Outlet />;
}

function PublicOnly() {
  const user = useAuth((s) => s.user);
  if (user) return <Navigate to="/chat" replace />;
  return <Outlet />;
}

export default function App() {
  const ready = useAuth((s) => s.ready);
  const bootstrap = useAuth((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 로그인 상태를 확인하는 짧은 순간
  if (!ready) return <div className="grid h-dvh place-items-center text-sm text-sand-400">불러오는 중…</div>;

  return (
    <Routes>
      {/* 공유 링크: 로그인과 상관없이 누구나 읽기만 */}
      <Route path="/share/:token" element={<SharedConversation />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<Admin />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
