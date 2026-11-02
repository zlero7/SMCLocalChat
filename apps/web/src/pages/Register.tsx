import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { GoogleSection } from '../components/GoogleButton';
import { ErrorBox, Field, PrimaryButton } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../store/auth';
import { AuthShell } from './AuthShell';

export default function Register() {
  const register = useAuth((s) => s.register);
  const navigate = useNavigate();

  const [needInvite, setNeedInvite] = useState(true);
  const [email, setEmail] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 서버가 초대 코드 가입 모드인지 확인해서 입력칸을 보여줄지 정한다
  useEffect(() => {
    api<{ registrationMode: 'open' | 'invite' }>('/auth/options', { noRefresh: true })
      .then((o) => setNeedInvite(o.registrationMode === 'invite'))
      .catch(() => {});
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('비밀번호 확인이 일치하지 않아요.');
      return;
    }
    setBusy(true);
    try {
      await register({
        email: email.trim(),
        nickname: nickname.trim(),
        password,
        inviteCode: needInvite ? inviteCode.trim() : undefined,
      });
      navigate('/chat', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="계정 만들기">
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
          label="닉네임"
          autoComplete="nickname"
          required
          maxLength={20}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
        />
        <Field
          label="비밀번호"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={100}
          hint="8자 이상"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          label="비밀번호 확인"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {needInvite && (
          <Field
            label="초대 코드"
            required
            autoComplete="off"
            placeholder="XXXX-XXXX"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
          />
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
        <PrimaryButton type="submit" disabled={busy} className="w-full">
          {busy ? '가입 중…' : '가입하기'}
        </PrimaryButton>
      </form>
      <p className="mt-6 text-center text-sm text-sand-500">
        이미 계정이 있나요?{' '}
        <Link to="/login" className="font-medium text-clay-600 hover:underline dark:text-clay-400">
          로그인
        </Link>
      </p>
    </AuthShell>
  );
}
