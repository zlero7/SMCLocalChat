import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { GoogleSection } from '../components/GoogleButton';
import { ErrorBox, Field, PrimaryButton } from '../components/ui';
import { errorMessage } from '../lib/api';
import { APP_NAME } from '../lib/brand';
import { useAuth } from '../store/auth';
import { AuthShell } from './AuthShell';

export default function Login() {
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/chat';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // 구글 로그인이 실패해서 돌아오면 서버가 ?error= 로 이유를 알려 준다
  const [error, setError] = useState<string | null>(() => new URLSearchParams(location.search).get('error'));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={`${APP_NAME}에 로그인`}>
      <GoogleSection />
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="이메일"
          type="email"
          autoComplete="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="비밀번호"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <ErrorBox>{error}</ErrorBox>}
        <PrimaryButton type="submit" disabled={busy} className="w-full">
          {busy ? '로그인 중…' : '로그인'}
        </PrimaryButton>
      </form>
      <p className="mt-4 text-center text-xs text-sand-400">
        비밀번호를 잊었다면 관리자에게 재설정 링크를 요청하세요. 구글로 가입했다면 "Google로 계속하기"로 들어올 수 있어요.
      </p>
      <p className="mt-6 text-center text-sm text-sand-500">
        계정이 없나요?{' '}
        <Link to="/register" className="font-medium text-clay-600 hover:underline dark:text-clay-400">
          가입하기
        </Link>
      </p>
    </AuthShell>
  );
}
