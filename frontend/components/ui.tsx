'use client';

import React from 'react';
import { statusStyle } from '@/lib/design';

/** Shared primitives. Kept in one file so the visual language is reviewable at a glance. */

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-[var(--surface-1)] ${padded ? 'p-4' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

/**
 * Status pill. Always colour + glyph + text — never colour alone, so the state
 * survives greyscale printing and colour-vision deficiency.
 */
export function StatusPill({ status, size = 'sm' }: { status: string; size?: 'sm' | 'xs' }) {
  const s = statusStyle(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 font-medium ${
        size === 'xs' ? 'py-0 text-[10px]' : 'py-0.5 text-xs'
      }`}
      style={{ borderColor: s.color, color: s.color }}
    >
      <span aria-hidden>{s.glyph}</span>
      {s.label}
    </span>
  );
}

export function Badge({
  children,
  color,
  title,
}: {
  children: React.ReactNode;
  color?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]"
      style={color ? { borderColor: color } : undefined}
    >
      {color && (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
        />
      )}
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  type = 'button',
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const sizes = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  const variants: Record<string, string> = {
    default: 'bg-[var(--surface-2)] hover:bg-[var(--surface-0)]',
    primary: 'border-transparent bg-[var(--series-1)] text-white hover:opacity-90',
    danger: 'border-transparent bg-[var(--status-critical)] text-white hover:opacity-90',
    ghost: 'border-transparent hover:bg-[var(--surface-2)]',
  };
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${sizes} ${variants[variant]}`}
    >
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-[var(--text-muted)]">
      <svg width="14" height="14" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label ?? 'Loading'}
    </span>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center">
      <p className="text-sm font-medium text-[var(--text-secondary)]">{title}</p>
      {hint && <p className="mt-1 max-w-md text-xs text-[var(--text-muted)]">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
      style={{ borderColor: 'var(--status-critical)', color: 'var(--status-critical)' }}
      role="alert"
    >
      <span aria-hidden className="mt-px">✕</span>
      <div className="flex-1">
        <p className="font-medium">Something went wrong</p>
        <p className="mt-0.5 opacity-90">{message}</p>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="shrink-0 underline underline-offset-2">
          Retry
        </button>
      )}
    </div>
  );
}

/** Hero number for a single headline figure — not a chart, on purpose. */
export function StatTile({
  label,
  value,
  sub,
  accent,
  glyph,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
  glyph?: string;
}) {
  return (
    <Card className="min-w-0">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-xs text-[var(--text-secondary)]">{label}</p>
        {glyph && (
          <span aria-hidden className="text-sm" style={{ color: accent ?? 'var(--text-muted)' }}>
            {glyph}
          </span>
        )}
      </div>
      <p
        className="tabular mt-1 text-2xl font-semibold leading-none"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </p>
      {sub && <p className="mt-1.5 truncate text-[11px] text-[var(--text-muted)]">{sub}</p>}
    </Card>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border bg-[var(--surface-2)] px-3 py-1.5 text-sm outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--series-1)]';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} resize-y ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

/** Collapsible block — used for long agent output, which is often thousands of words. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <span aria-hidden className="transition-transform group-open:rotate-90">▸</span>
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  );
}

/** Pre-formatted agent output with a copy affordance. */
export function OutputBlock({ text, maxHeight = 320 }: { text: string; maxHeight?: number }) {
  return (
    <pre
      className="overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-[var(--surface-2)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]"
      style={{ maxHeight }}
    >
      {text}
    </pre>
  );
}
