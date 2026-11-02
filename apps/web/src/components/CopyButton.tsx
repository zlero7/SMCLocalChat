import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './Icons';

/** 클립보드 복사. https 가 아닌 사설 주소(IP 직접 접속)에서도 되도록 예비 방법을 둔다. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  text,
  label = '복사',
  className = '',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1800);
        }
      }}
      className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors ${className}`}
      aria-label={copied ? '복사됨' : label}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      <span>{copied ? '복사됨' : label}</span>
    </button>
  );
}
