import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useGoogle } from '../store/google';
import { MailIcon } from './Icons';
import { ErrorBox, PrimaryButton, SecondaryButton } from './ui';

/** 설정의 "구글 계정" 칸: 구글 로그인 연결 상태, Gmail 연결·끊기 */
export function GoogleSettings() {
  const status = useGoogle((s) => s.status);
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get('google_error'));
  const justConnected = params.get('google') === 'connected';

  useEffect(() => {
    void useGoogle.getState().load();
  }, []);

  if (!status) return <p className="text-sm text-sand-500">불러오는 중…</p>;
  if (!status.configured) {
    return (
      <p className="text-sm text-sand-500">
        이 사이트에는 아직 구글 로그인이 설정되어 있지 않아요. (관리자가 서버의 .env 에 구글 OAuth 정보를 넣으면 켜져요)
      </p>
    );
  }

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>('/google/gmail/connect', { method: 'POST' });
      window.location.href = url; // 구글 동의 화면으로 갔다가 설정으로 돌아온다
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Gmail 연결을 끊을까요? 구글에도 권한을 돌려줘요.')) return;
    setBusy(true);
    setError(null);
    try {
      await api('/google/gmail', { method: 'DELETE' });
      await useGoogle.getState().load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="font-medium">구글 로그인</p>
        <p className="mt-0.5 text-sand-500">
          {status.linked
            ? '이 계정은 구글 로그인으로 들어올 수 있어요.'
            : '로그인 화면의 "Google 로 계속하기" 를 쓰면, 같은 이메일의 구글 계정이 이 계정에 자동으로 이어져요.'}
          {!status.hasPassword && ' 비밀번호가 없는 계정이라 이메일로 로그인하려면 아래 "비밀번호 변경" 에서 비밀번호를 정하세요.'}
        </p>
      </div>

      <div className="rounded-xl border border-sand-200 p-3.5 dark:border-sand-700">
        <div className="flex items-start gap-2.5">
          <MailIcon size={18} className="mt-0.5 shrink-0 text-sand-500" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Gmail {status.gmail ? '연결됨' : '연결 안 됨'}</p>
            {status.gmail ? (
              <p className="mt-0.5 text-sand-500">
                {status.gmail.email} · {new Date(status.gmail.connectedAt).toLocaleDateString('ko-KR')} 연결. 입력창의 ✉️ 버튼을
                켜면 AI 가 메일을 찾아 읽고 요약해요. <b className="font-medium">읽기만</b> 하고 보내거나 지우지는 못해요.
              </p>
            ) : (
              <p className="mt-0.5 text-sand-500">
                연결하면 "오늘 온 메일 요약해 줘", "○○에게 받은 메일 찾아 줘" 처럼 물어볼 수 있어요. 메일 읽기 권한만 받아요.
              </p>
            )}
            {justConnected && status.gmail && <p className="mt-1.5 text-clay-600 dark:text-clay-400">Gmail 을 연결했어요.</p>}
          </div>
          {status.gmail ? (
            <SecondaryButton type="button" onClick={() => void disconnect()} disabled={busy} className="shrink-0 px-3 py-1.5">
              연결 끊기
            </SecondaryButton>
          ) : (
            <PrimaryButton type="button" onClick={() => void connect()} disabled={busy} className="shrink-0 px-3 py-1.5">
              {busy ? '이동 중…' : 'Gmail 연결'}
            </PrimaryButton>
          )}
        </div>
        <p className="mt-2.5 text-xs text-sand-400">
          메일 안에 적힌 지시는 AI 가 따르지 않게 했고, 메일을 읽은 답변에서는 웹 검색·페이지 읽기를 막아 메일 내용이 바깥으로 나가지 않게 했어요.
          구글 앱이 "테스트" 상태면 7일마다 다시 연결해야 할 수 있어요.
        </p>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}
