import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { ErrorBox, PrimaryButton, SecondaryButton, inputClass } from './ui';

interface BotInfo {
  botId: string;
  botName: string;
  enabled: boolean;
  allowedChannels: string;
  allowedUsers: string;
  allowDm: boolean;
  channelChat: boolean;
  inviteUrl: string;
  status: { state: 'off' | 'starting' | 'online' | 'error'; error?: string; guilds?: number };
}
interface View {
  serverEnabled: boolean;
  limits: { perHour: number; perDay: number };
  bot: BotInfo | null;
}

const STATE_LABEL: Record<BotInfo['status']['state'], { text: string; color: string }> = {
  online: { text: '켜져 있어요', color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300' },
  starting: { text: '켜는 중…', color: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300' },
  error: { text: '문제가 있어요', color: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300' },
  off: { text: '꺼져 있어요', color: 'bg-sand-200 text-sand-700 dark:bg-sand-700 dark:text-sand-200' },
};

/** 설정의 "디스코드 봇": 내가 만든 디스코드 봇을 연결하면 디스코드에서도 이 사이트의 AI 와 대화할 수 있다 */
export function DiscordSettings() {
  const [view, setView] = useState<View | null>(null);
  const [token, setToken] = useState('');
  const [channels, setChannels] = useState('');
  const [users, setUsers] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = (v: View) => {
    setView(v);
    setChannels(v.bot?.allowedChannels.replace(/,/g, ', ') ?? '');
    setUsers(v.bot?.allowedUsers.replace(/,/g, ', ') ?? '');
  };

  useEffect(() => {
    api<View>('/discord').then(apply, (e) => setError(errorMessage(e)));
  }, []);

  // 연결 직후에는 "켜는 중"이라서, 켜질 때까지 몇 초마다 다시 확인한다
  useEffect(() => {
    if (view?.bot?.status.state !== 'starting' && !(view?.bot?.enabled && view.bot.status.state === 'off')) return;
    const t = setTimeout(() => api<View>('/discord').then((v) => setView(v), () => {}), 3000);
    return () => clearTimeout(t);
  }, [view]);

  const run = async (fn: () => Promise<View | void>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const v = await fn();
      if (v) apply(v);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api<View>('/discord/token', { method: 'PUT', body: { token: token.trim() } }))) setToken('');
  };
  const patch = (body: Record<string, unknown>) => run(() => api<View>('/discord', { method: 'PATCH', body }));
  const saveAccess = async () => {
    if (await patch({ allowedChannels: channels, allowedUsers: users })) setSaved(true);
  };
  const retry = () => run(() => api<View>('/discord/retry', { method: 'POST' }));
  const disconnect = async () => {
    if (!window.confirm('디스코드 봇 연결을 끊을까요? 저장된 토큰이 지워지고 봇이 꺼져요.')) return;
    await run(async () => {
      await api('/discord', { method: 'DELETE' });
      return { ...(view as View), bot: null };
    });
  };

  if (!view) return error ? <ErrorBox>{error}</ErrorBox> : <p className="text-sm text-sand-500">불러오는 중…</p>;
  if (!view.serverEnabled) {
    return <p className="text-sm text-sand-500">관리자가 이 사이트의 디스코드 봇 기능을 꺼 두었어요.</p>;
  }
  const bot = view.bot;

  return (
    <div className="space-y-4 text-sm">
      {!bot && (
        <div className="space-y-2 leading-relaxed text-sand-500 dark:text-sand-400">
          <p>내가 만든 디스코드 봇을 연결하면, 디스코드에서도 이 사이트의 AI 와 대화할 수 있어요. (<code>/ask 질문</code>, 봇 @멘션, DM)</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className="font-medium text-clay-600 underline dark:text-clay-400">
                디스코드 개발자 포털
              </a>
              에서 <b>New Application</b>을 만들어요.
            </li>
            <li>
              왼쪽 <b>Bot</b> 메뉴 → <b>Reset Token</b>으로 토큰을 만들고 복사해요. 같은 화면에서 <b>Public Bot은 끄고</b>, 아래쪽 <b>Message Content Intent는 켜세요</b>
              (지정한 채널에서 @멘션 없이 그냥 채팅하려면 필요해요. 안 쓸 거면 꺼 둬도 돼요).
            </li>
            <li>복사한 토큰을 아래 칸에 붙여 넣고 <b>연결</b>을 눌러요. 그러면 서버에 봇을 초대하는 링크가 나와요.</li>
          </ol>
          <p className="text-xs">
            토큰은 봇의 비밀번호예요. 이 칸 말고 다른 곳에 붙여 넣지 마세요. 저장할 때 암호화하고, 한 번 저장하면 다시 보여 주지 않아요.
          </p>
        </div>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      {!bot ? (
        <form onSubmit={connect} className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-xs text-sand-500">봇 토큰</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className={`${inputClass} font-mono`}
            />
          </label>
          <PrimaryButton type="submit" disabled={busy || token.trim().length < 30}>
            {busy ? '확인하는 중…' : '연결'}
          </PrimaryButton>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{bot.botName}</span>
            <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${STATE_LABEL[bot.enabled ? bot.status.state : 'off'].color}`}>
              {bot.enabled ? STATE_LABEL[bot.status.state].text : '꺼 둠'}
            </span>
            {bot.status.state === 'online' && bot.enabled && <span className="text-xs text-sand-500">서버 {bot.status.guilds ?? 0}개에 들어가 있어요</span>}
          </div>
          {bot.status.state === 'error' && bot.enabled && (
            <div className="space-y-2">
              <ErrorBox>{bot.status.error}</ErrorBox>
              <SecondaryButton type="button" onClick={() => void retry()} disabled={busy}>
                다시 연결
              </SecondaryButton>
            </div>
          )}

          <div className="rounded-lg bg-sand-100 p-3 dark:bg-sand-800">
            <p className="mb-1.5 text-xs text-sand-500">
              {bot.status.state === 'online' && (bot.status.guilds ?? 0) > 0 ? '다른 서버에도 넣으려면' : '이 링크로 내 서버에 봇을 초대하세요'} (서버 관리 권한이 있어야 해요)
            </p>
            <a
              href={bot.inviteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block rounded-lg bg-clay-500 px-3.5 py-2 text-sm font-semibold text-white hover:bg-clay-600"
            >
              서버에 봇 초대하기
            </a>
          </div>

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={bot.enabled} disabled={busy} onChange={(e) => void patch({ enabled: e.target.checked })} />
            <span>봇 켜기</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={bot.channelChat}
              disabled={busy}
              onChange={(e) => void patch({ channelChat: e.target.checked })}
            />
            <span>
              아래 <b>답할 채널</b>에서는 @멘션이나 /ask 없이 <b>그냥 채팅만 쳐도</b> 답하기
              <span className="block text-xs text-sand-500">
                채널 ID를 넣어야 동작하고, 개발자 포털에서 Message Content Intent를 켜야 해요. 사람끼리 하는 말은 앞에 // 를 붙이면 봇이 무시해요.
              </span>
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={bot.allowDm} disabled={busy} onChange={(e) => void patch({ allowDm: e.target.checked })} />
            <span>DM(1:1 메시지)으로도 대화하기</span>
          </label>

          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs text-sand-500">답할 채널 ID (비우면 봇이 볼 수 있는 모든 채널)</span>
              <input value={channels} onChange={(e) => (setChannels(e.target.value), setSaved(false))} placeholder="예: 123456789012345678, 223456789012345678" className={`${inputClass} font-mono`} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-sand-500">봇을 쓸 수 있는 사람의 디스코드 ID (비우면 봇을 부를 수 있는 누구나)</span>
              <input value={users} onChange={(e) => (setUsers(e.target.value), setSaved(false))} placeholder="예: 323456789012345678" className={`${inputClass} font-mono`} />
            </label>
            <div className="flex items-center gap-3">
              <PrimaryButton type="button" onClick={() => void saveAccess()} disabled={busy}>
                저장
              </PrimaryButton>
              {saved && <span className="text-xs text-clay-600 dark:text-clay-400">저장했어요</span>}
            </div>
          </div>

          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <b>내 사용량이 쓰여요.</b> 이 봇이 답하는 데 쓴 양은 모두 <b>내 5시간 사용량</b>에서 빠져요. 서버의 다른 사람이 불러도 마찬가지예요. 믿을 사람만 쓰게 하려면
            위에 <b>디스코드 ID</b>를 넣어 제한하세요 (디스코드 설정 → 고급 → 개발자 모드를 켜고, 사람이나 채널을 우클릭 → ID 복사). 사람 한 명당 1시간에{' '}
            {view.limits.perHour}번, 하루 {view.limits.perDay}번까지만 물을 수 있어요. 봇은 올려 준 이미지·PDF·워드·텍스트·코드 파일을 볼 수 있고, 요청하면 글로 된 파일을 만들어 올려요. 인터넷·메일·내 컴퓨터 파일은 볼 수 없어요.
          </div>

          <SecondaryButton type="button" onClick={() => void disconnect()} disabled={busy}>
            연결 끊기
          </SecondaryButton>
        </>
      )}
    </div>
  );
}
