import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SparkIcon } from '../components/Icons';

/** 로그인/가입 화면의 공통 틀 */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <SparkIcon size={36} className="text-clay-500" />
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        </div>
        {children}
        <p className="mt-8 text-center text-xs text-sand-400">
          <Link to="/privacy" className="hover:underline">
            개인정보 처리방침
          </Link>
          {' · '}
          <Link to="/terms" className="hover:underline">
            이용약관
          </Link>
        </p>
      </div>
    </div>
  );
}
