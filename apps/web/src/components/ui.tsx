import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

export const inputClass =
  'w-full rounded-xl border border-sand-300 bg-white px-3.5 py-2.5 text-[15px] outline-none transition-colors placeholder:text-sand-400 focus:border-clay-500 focus:ring-2 focus:ring-clay-500/20 disabled:opacity-60 dark:border-sand-700 dark:bg-sand-900 dark:focus:border-clay-500';

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-sand-700 dark:text-sand-300">
        {label}
      </label>
      <input id={id} className={inputClass} {...props} />
      {hint && <p className="mt-1.5 text-xs text-sand-500">{hint}</p>}
    </div>
  );
}

export function PrimaryButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`rounded-xl bg-clay-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-clay-700 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    />
  );
}

export function SecondaryButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`rounded-xl border border-sand-300 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-sand-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sand-700 dark:hover:bg-sand-800 ${className}`}
    />
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
      {children}
    </p>
  );
}
