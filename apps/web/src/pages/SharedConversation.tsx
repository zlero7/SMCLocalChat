import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FileIcon, SparkIcon } from '../components/Icons';
import { Markdown } from '../components/Markdown';
import { ToolSteps } from '../components/ToolActivity';
import { APP_NAME } from '../lib/brand';
import type { ToolStep } from '../lib/types';

interface SharedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: string;
  model: string | null;
  tools: ToolStep[];
  attachments: { name: string; kind: string }[];
}

interface Shared {
  title: string;
  sharedBy: string;
  sharedAt: string;
  messages: SharedMessage[];
}

/** 공유 링크로 연 대화 (로그인 없이 읽기만) */
export default function SharedConversation() {
  const { token } = useParams();
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 로그인 없이 여는 화면이라 토큰을 붙이지 않고 직접 부른다
    fetch(`/api/share/${encodeURIComponent(token ?? '')}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? '대화를 불러오지 못했어요.');
        setData(body as Shared);
        document.title = `${(body as Shared).title} · ${APP_NAME}`;
      })
      .catch((err: Error) => setError(err.message));
  }, [token]);

  return (
    <div className="min-h-dvh bg-sand-50 dark:bg-sand-900">
      <header className="sticky top-0 z-10 border-b border-sand-200 bg-sand-50/90 backdrop-blur dark:border-sand-800 dark:bg-sand-900/90">
        <div className="mx-auto flex h-12 max-w-3xl items-center gap-2 px-4">
          <SparkIcon size={18} className="text-clay-500" />
          <Link to="/" className="font-semibold tracking-tight">
            {APP_NAME}
          </Link>
          <span className="ml-2 rounded-md bg-sand-200/70 px-1.5 py-0.5 text-xs text-sand-600 dark:bg-sand-800 dark:text-sand-300">
            공유된 대화 · 읽기 전용
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6 pb-16">
        {!data && !error && <p className="text-sm text-sand-500">불러오는 중…</p>}
        {error && (
          <div className="mt-16 text-center">
            <p className="text-sand-600 dark:text-sand-300">{error}</p>
            <p className="mt-1 text-sm text-sand-400">공유한 사람이 링크를 껐거나 대화를 지웠을 수 있어요.</p>
          </div>
        )}
        {data && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">{data.title}</h1>
            <p className="mt-1 text-sm text-sand-500">
              {data.sharedBy}님이 {new Date(data.sharedAt).toLocaleString('ko-KR')}에 공유함
            </p>
            <div className="mt-8 space-y-7">
              {data.messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="flex flex-col items-end gap-1.5">
                    {m.attachments.length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {m.attachments.map((a, i) => (
                          <span
                            key={i}
                            className="flex items-center gap-1 rounded-lg border border-sand-200 px-2 py-1 text-xs text-sand-600 dark:border-sand-700 dark:text-sand-300"
                          >
                            <FileIcon size={12} /> {a.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="max-w-[85%] rounded-2xl bg-sand-200/70 px-4 py-2.5 text-[15px] leading-7 wrap-anywhere whitespace-pre-wrap dark:bg-sand-950">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id}>
                    <ToolSteps steps={m.tools ?? []} />
                    {m.content ? <Markdown text={m.content} /> : <p className="text-sm text-sand-400">(답변 없음)</p>}
                  </div>
                ),
              )}
            </div>
            <p className="mt-12 border-t border-sand-200 pt-4 text-center text-xs text-sand-400 dark:border-sand-800">
              AI 가 만든 답변은 틀릴 수 있어요. 중요한 내용은 다시 확인해 주세요.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
