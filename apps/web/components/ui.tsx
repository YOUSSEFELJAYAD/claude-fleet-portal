'use client';
import React from 'react';
import type { RunStatus } from '@fleet/shared';
import { statusMeta } from '@/lib/status';

export function Kicker({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`kicker ${className}`}>{children}</div>;
}

export function Panel({
  children,
  className = '',
  ticked = false,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  ticked?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`panel ${ticked ? 'ticked' : ''} ${className}`} style={style}>
      {children}
    </div>
  );
}

/** pulsing signal dot keyed to a status color */
export function Dot({ color, live = false, size = 7 }: { color: string; live?: boolean; size?: number }) {
  return (
    <span
      className={live ? 'animate-pulseGlow' : ''}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        color,
        boxShadow: live ? `0 0 8px ${color}` : 'none',
        flex: '0 0 auto',
      }}
    />
  );
}

/** Generic HUD pill — a colored uppercase label with a leading status dot. The canonical
 *  replacement for the hand-rolled {Dot + bordered span} pills that drifted across pages
 *  (kind badges, status chips, etc.). StatusBadge is the run-status specialization. */
export function Badge({ label, color, live = false, big = false }: { label: React.ReactNode; color: string; live?: boolean; big?: boolean }) {
  return (
    <span
      className="font-display inline-flex items-center gap-1.5 uppercase tracking-wider"
      style={{
        color,
        fontSize: big ? 11 : 9.5,
        border: `1px solid ${color}40`,
        background: `${color}12`,
        padding: big ? '3px 8px' : '2px 6px',
        letterSpacing: '0.12em',
      }}
    >
      <Dot color={color} live={live} size={big ? 7 : 6} />
      {label}
    </span>
  );
}

export function StatusBadge({ status, big = false }: { status: RunStatus; big?: boolean }) {
  const m = statusMeta(status);
  return <Badge label={m.label} color={m.color} live={m.live} big={big} />;
}

export function Stat({
  label,
  value,
  accent,
  className = '',
  sub,
}: {
  label: string;
  value: React.ReactNode;
  accent?: string;
  className?: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Kicker>{label}</Kicker>
      <div className="font-mono tnum mt-1 text-[15px]" style={{ color: accent ?? '#e9e7df' }}>
        {value}
      </div>
      {sub && <div className="text-faint font-mono text-[10px] mt-0.5">{sub}</div>}
    </div>
  );
}

export function Btn({
  children,
  onClick,
  variant = 'ghost',
  className = '',
  disabled = false,
  type = 'button',
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'ghost' | 'amber' | 'danger' | 'solid';
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const base =
    'font-display uppercase tracking-wider text-[11px] px-3 py-1.5 border transition-all duration-150 disabled:opacity-35 disabled:cursor-not-allowed inline-flex items-center gap-1.5 select-none';
  const styles: Record<string, string> = {
    ghost: 'border-line2 text-dim hover:text-ink hover:border-amber/60 hover:bg-amber/5',
    amber: 'border-amber/60 text-amber hover:bg-amber/15 bg-amber/8',
    danger: 'border-sig-failed/50 text-sig-failed hover:bg-sig-failed/15 bg-sig-failed/8',
    solid: 'border-amber bg-amber text-black font-semibold hover:bg-[#ffc23d]',
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${styles[variant]} ${className}`}>
      {children}
    </button>
  );
}

/** Segmented tab / filter pill — the canonical control for filter rows and sub-tabs
 *  (active = amber, inactive = ghost), replacing the copy-pasted inline-hex pill markup. */
export function Tab({
  active,
  onClick,
  children,
  className = '',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`font-display uppercase tracking-wider text-[10px] px-3 py-1.5 border transition-colors ${
        active ? 'border-amber/60 text-amber bg-amber/8' : 'border-line2 text-dim hover:text-ink hover:border-amber/40'
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** budget heat gauge — the signature element: green → amber → red as cost nears the cap */
export function Gauge({ value, cap, label }: { value: number; cap: number | null; label?: string }) {
  const ratio = cap && cap > 0 ? Math.min(value / cap, 1) : 0;
  const pct = Math.round(ratio * 100);
  const color = ratio < 0.5 ? '#54e08a' : ratio < 0.8 ? '#ffb000' : '#ff5d5d';
  const hot = ratio >= 0.8;
  return (
    <div>
      {label && (
        <div className="flex justify-between items-baseline mb-1">
          <Kicker>{label}</Kicker>
          <span className="font-mono tnum text-[10px]" style={{ color }}>
            {cap ? `${pct}%` : 'no cap'}
          </span>
        </div>
      )}
      <div className="h-1.5 w-full bg-white/5 overflow-hidden relative" style={{ boxShadow: hot ? `0 0 10px -2px ${color}` : 'none' }}>
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${Math.max(ratio * 100, value > 0 ? 2 : 0)}%`, background: color }}
        />
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <Kicker>{label}</Kicker>
        {hint && <span className="text-faint text-[9px] font-mono">{hint}</span>}
      </div>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputCls =
  'w-full bg-black/40 border border-line2 text-ink font-mono text-[13px] px-2.5 py-2 focus:border-amber/70 outline-none placeholder:text-faint';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} resize-y ${props.className ?? ''}`} />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${inputCls} appearance-none cursor-pointer ${props.className ?? ''}`}>
      {props.children}
    </select>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="inline-flex items-center gap-2 group"
    >
      <span
        className="relative w-8 h-4 border transition-colors"
        style={{
          borderColor: on ? '#ffb000' : 'rgba(255,255,255,0.2)',
          background: on ? 'rgba(255,176,0,0.18)' : 'transparent',
        }}
      >
        <span
          className="absolute top-0.5 h-2.5 w-2.5 transition-all"
          style={{ left: on ? 16 : 2, background: on ? '#ffb000' : '#7b828c' }}
        />
      </span>
      {label && <span className="font-mono text-[11px] text-dim group-hover:text-ink">{label}</span>}
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-dashed border-line2 py-14 text-center text-faint font-mono text-[12px]">
      {children}
    </div>
  );
}

/** The one canonical error/alert box — square HUD, sig-failed palette. Replaces the
 *  hand-rolled inline-hex banners that drifted across pages. Optional inline retry. */
export function ErrorBanner({
  children,
  className = '',
  onRetry,
}: {
  children: React.ReactNode;
  className?: string;
  onRetry?: () => void;
}) {
  return (
    <div className={`border border-sig-failed/40 bg-sig-failed/8 text-sig-failed font-mono text-[12px] px-3 py-2 ${className}`}>
      {children}
      {onRetry && (
        <button type="button" onClick={onRetry} className="ml-2 underline hover:text-ink transition-colors">
          retry
        </button>
      )}
    </div>
  );
}
