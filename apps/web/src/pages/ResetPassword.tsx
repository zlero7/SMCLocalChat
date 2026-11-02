import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ErrorBox, Field, PrimaryButton } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { AuthShell } from './AuthShell';

/** 관리자가 보내 준 일회용 링크로 새 비밀번호를 정하는 화면 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError('비밀번호 확인이 일치하지 않아요.');
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: password }, noRefresh: true });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title="비밀번호 재설정">
        <ErrorBox>링크가 올바르지 않아요. 관리자에게 받은 링크를 그대로 열어 주세요.</ErrorBox>
      </AuthShell>
    );
  }
  if (done) {
    return (
      <AuthShell title="비밀번호를 바꿨어요">
        <p className="text-center text-sm text-sand-500">새 비밀번호로 로그인해 주세요. 다른 기기의 로그인은 모두 풀렸어요.</p>
        <Link to="/login" className="mt-6 block rounded-lg bg-clay-500 px-4 py-2 text-center font-semibold text-white hover:bg-clay-600">
          로그인하기
        </Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="새 비밀번호 정하기">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="새 비밀번호 (8자 이상)" type="password" autoComplete="new-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        <Field label="새 비밀번호 확인" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && <ErrorBox>{error}</ErrorBox>}
        <PrimaryButton type="submit" disabled={busy} className="w-full">
          {busy ? '바꾸는 중…' : '비밀번호 바꾸기'}
        </PrimaryButton>
      </form>
    </AuthShell>
  );
}
