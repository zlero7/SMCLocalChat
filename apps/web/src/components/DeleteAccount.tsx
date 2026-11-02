import { useState, type FormEvent } from 'react';
import { api, errorMessage, setAccessToken } from '../lib/api';
import type { User } from '../lib/types';
import { ErrorBox, Field, SecondaryButton } from './ui';

/** 설정의 "계정 삭제": 이메일을 똑같이 입력해야 지워지고, 비밀번호가 있는 계정은 비밀번호도 맞아야 한다 */
export function DeleteAccount({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/me', { method: 'DELETE', body: { confirmEmail: email, password: password || undefined } });
      setAccessToken(null);
      window.location.assign('/login'); // 화면의 모든 상태를 버리고 처음부터
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div>
        <p className="text-sm text-sand-500">내 대화, 파일, 기억, 예약, 프로젝트, 공유 링크와 Gmail·디스코드 봇 연결이 모두 지워져요. 되돌릴 수 없어요.</p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 rounded-lg border border-red-300 px-3.5 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          계정 삭제…
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-red-200 bg-red-50/50 p-4 dark:border-red-900 dark:bg-red-950/20">
      <p className="text-sm font-medium text-red-700 dark:text-red-300">정말 지울까요? 되돌릴 수 없어요.</p>
      <Field
        label={`확인을 위해 내 이메일(${user.email})을 입력하세요`}
        type="email"
        autoComplete="off"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Field label="비밀번호 (비밀번호가 없는 구글 계정이면 비워 두세요)" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || email.trim().toLowerCase() !== user.email.toLowerCase()}
          className="rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40"
        >
          {busy ? '지우는 중…' : '영구 삭제'}
        </button>
        <SecondaryButton type="button" onClick={() => setOpen(false)} disabled={busy}>
          취소
        </SecondaryButton>
      </div>
    </form>
  );
}
