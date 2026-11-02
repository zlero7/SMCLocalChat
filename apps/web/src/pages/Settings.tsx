import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { DeleteAccount } from '../components/DeleteAccount';
import { DiscordSettings } from '../components/DiscordSettings';
import { GoogleSettings } from '../components/GoogleSettings';
import { RunnerSettings } from '../components/RunnerSettings';
import { MemorySettings } from '../components/MemorySettings';
import { StyleSettings } from '../components/StyleSettings';
import { UsageBar } from '../components/UsageBar';
import { ErrorBox, Field, PrimaryButton, SecondaryButton, inputClass } from '../components/ui';
import { api, errorMessage, setAccessToken } from '../lib/api';
import type { User } from '../lib/types';
import { useAuth } from '../store/auth';
import { useGoogle } from '../store/google';
import { useStyles } from '../store/styles';
import { useTheme, type Theme } from '../store/theme';
import { useUsage } from '../store/usage';

interface PatchResponse {
  user: User;
  accessToken?: string;
}

function Card({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-6 rounded-2xl border border-sand-200 bg-white p-5 shadow-[0_1px_3px_0] shadow-sand-900/5 sm:p-6 dark:border-sand-800 dark:bg-sand-800/50"
    >
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm leading-relaxed text-sand-500 dark:text-sand-400">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** 저장 결과(성공/실패)를 버튼 옆에 보여주는 작은 훅 */
function useSave() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<void>, okText = '저장했어요.') => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ ok: true, text: okText });
    } catch (err) {
      setMessage({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, run };
}

function SaveRow({ busy, message, label = '저장' }: { busy: boolean; message: { ok: boolean; text: string } | null; label?: string }) {
  return (
    <div className="mt-4 flex items-center gap-3">
      <PrimaryButton type="submit" disabled={busy}>
        {busy ? '저장 중…' : label}
      </PrimaryButton>
      {message && (
        <span role="status" className={`text-sm ${message.ok ? 'text-clay-600 dark:text-clay-400' : 'text-red-600 dark:text-red-400'}`}>
          {message.text}
        </span>
      )}
    </div>
  );
}

export default function Settings() {
  const user = useAuth((s) => s.user)!;
  const setUser = useAuth((s) => s.setUser);
  const logout = useAuth((s) => s.logout);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);

  const patch = async (body: Record<string, unknown>) => {
    const res = await api<PatchResponse>('/me', { method: 'PATCH', body });
    if (res.accessToken) setAccessToken(res.accessToken);
    setUser(res.user);
  };

  const [nickname, setNickname] = useState(user.nickname);
  const profile = useSave();

  const [instruction, setInstruction] = useState(user.customInstruction);
  const custom = useSave();

  const usage = useUsage((s) => s.usage);
  const stylesLoaded = useStyles((s) => s.loaded);
  const loadStyles = useStyles((s) => s.load);
  const [stylesError, setStylesError] = useState<string | null>(null);

  useEffect(() => {
    void useUsage.getState().refresh();
    if (!stylesLoaded) loadStyles().catch((err) => setStylesError(errorMessage(err)));
  }, [stylesLoaded, loadStyles]);

  // 입력창의 "스타일 만들기·편집" 으로 들어오면 스타일 카드로 바로 이동
  const location = useLocation();
  useEffect(() => {
    if (location.hash === '#styles' && stylesLoaded) {
      document.getElementById('styles')?.scrollIntoView({ behavior: 'smooth' });
    }
    // 답변 아래 "기억했어요 · 관리" 로 들어오면 기억 칸으로
    if (location.hash === '#memory') document.getElementById('memory')?.scrollIntoView({ behavior: 'smooth' });
    if (location.hash === '#google') document.getElementById('google')?.scrollIntoView({ behavior: 'smooth' });
  }, [location.hash, stylesLoaded]);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const password = useSave();
  // 구글로만 가입한 계정은 현재 비밀번호 없이 새로 정한다
  const hasPassword = useGoogle((s) => s.status?.hasPassword ?? true);

  const onPassword = (e: FormEvent) => {
    e.preventDefault();
    void password.run(async () => {
      if (next !== confirm) throw new Error('새 비밀번호 확인이 일치하지 않아요.');
      await patch({ currentPassword: hasPassword ? current : undefined, newPassword: next });
      void useGoogle.getState().load();
      setCurrent('');
      setNext('');
      setConfirm('');
    }, '비밀번호를 바꿨어요. 다른 기기에서는 로그아웃돼요.');
  };

  const themes: { value: Theme; label: string }[] = [
    { value: 'system', label: '시스템 설정 따라가기' },
    { value: 'light', label: '라이트' },
    { value: 'dark', label: '다크' },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6 pb-12">
        <h1 className="text-2xl font-semibold tracking-tight">설정</h1>

        <Card title="프로필" description={user.email}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void profile.run(() => patch({ nickname }));
            }}
          >
            <Field label="닉네임" required maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} />
            <SaveRow busy={profile.busy} message={profile.message} />
          </form>
        </Card>

        <Card
          title="5시간 사용량"
          description="질문과 답변에 쓴 토큰 수예요. 첫 메시지를 보낸 때부터 5시간이 지나면 0으로 돌아가요. 한도는 관리자가 정해요."
        >
          {usage ? <UsageBar usage={usage} /> : <p className="text-sm text-sand-500">불러오는 중…</p>}
        </Card>

        <Card
          id="styles"
          title="응답 스타일"
          description="AI 가 답하는 말투와 형식이에요. 기본 스타일을 고르거나, 복사해서 나에게 맞게 고친 내 스타일을 만들 수 있어요. 입력창 왼쪽 아래에서도 바꿀 수 있어요."
        >
          {stylesError ? (
            <ErrorBox>{stylesError}</ErrorBox>
          ) : stylesLoaded ? (
            <StyleSettings />
          ) : (
            <p className="text-sm text-sand-500">불러오는 중…</p>
          )}
        </Card>

        <Card
          title="개인 지침"
          description="스타일과 상관없이 모든 대화에서 AI 가 알고 있어야 할 나에 대한 정보나 규칙이에요. 예: 나는 고등학생이야, 코드에는 주석을 달아 줘, 답은 항상 존댓말로"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void custom.run(() => patch({ customInstruction: instruction }));
            }}
          >
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={2000}
              rows={5}
              aria-label="개인 지침"
              placeholder="AI 가 기억해 줬으면 하는 것을 적어 주세요"
              className={`${inputClass} resize-y`}
            />
            <p className="mt-1 text-right text-xs text-sand-500">{instruction.length} / 2000</p>
            <SaveRow busy={custom.busy} message={custom.message} />
          </form>
        </Card>

        <Card
          id="memory"
          title="기억"
          description="개인 지침은 내가 직접 쓰고, 기억은 AI 가 대화에서 알아서 적어 둬요. 무엇을 기억했는지 여기서 보고 지울 수 있어요."
        >
          <MemorySettings />
        </Card>

        <Card id="google" title="구글 계정" description="구글로 로그인하고, Gmail 을 연결해 AI 가 메일을 찾아 읽게 할 수 있어요.">
          <GoogleSettings />
        </Card>

        <Card
          id="discord"
          title="디스코드 봇"
          description="내 디스코드 봇을 연결하면 디스코드에서도 이 사이트의 AI 와 대화할 수 있어요."
        >
          <DiscordSettings />
        </Card>

        <Card
          id="runner"
          title="프로그램 실행"
          description="AI 가 내 컴퓨터의 작업 폴더에서 명령을 실행하게 하는 도우미를 연결해요 (선택)."
        >
          <RunnerSettings />
        </Card>

        <Card title="화면 테마">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="화면 테마">
            {themes.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={theme === t.value}
                onClick={() => setTheme(t.value)}
                className={`rounded-xl border px-3.5 py-2 text-sm transition-colors ${
                  theme === t.value
                    ? 'border-clay-600 bg-clay-50 font-medium text-clay-800 dark:bg-clay-950/40 dark:text-clay-300'
                    : 'border-sand-300 hover:bg-sand-100 dark:border-sand-700 dark:hover:bg-sand-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Card>

        <Card
          title={hasPassword ? '비밀번호 변경' : '비밀번호 정하기'}
          description={hasPassword ? undefined : '구글로 가입해서 아직 비밀번호가 없어요. 정해 두면 이메일로도 로그인할 수 있어요.'}
        >
          <form onSubmit={onPassword} className="space-y-4">
            {hasPassword && (
              <Field label="현재 비밀번호" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
            )}
            <Field label="새 비밀번호" type="password" autoComplete="new-password" required minLength={8} maxLength={100} hint="8자 이상" value={next} onChange={(e) => setNext(e.target.value)} />
            <Field label="새 비밀번호 확인" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {password.message && !password.message.ok && <ErrorBox>{password.message.text}</ErrorBox>}
            <div className="flex items-center gap-3">
              <PrimaryButton type="submit" disabled={password.busy}>
                {password.busy ? '바꾸는 중…' : '비밀번호 바꾸기'}
              </PrimaryButton>
              {password.message?.ok && (
                <span role="status" className="text-sm text-clay-600 dark:text-clay-400">
                  {password.message.text}
                </span>
              )}
            </div>
          </form>
        </Card>

        <Card title="계정">
          <SecondaryButton type="button" onClick={() => void logout()}>
            로그아웃
          </SecondaryButton>
        </Card>

        <Card id="delete-account" title="계정 삭제">
          <DeleteAccount user={user} />
        </Card>
      </div>
    </div>
  );
}
