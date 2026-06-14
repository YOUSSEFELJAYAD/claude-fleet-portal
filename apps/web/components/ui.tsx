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

/** Small bordered metadata chip — a dot-less label tag (branch, wip, ceiling, paused, …).
 *  Defaults to the dim/line token palette; pass className to tint or uppercase
 *  (e.g. "uppercase tracking-wider text-sig-killed border-sig-killed/50"). */
export function Chip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-[10px] px-1.5 py-0.5 border border-line2 text-dim ${className}`}>
      {children}
    </span>
  );
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

// ─────────────────────────────────────────────────────────────────────────────
// §9 — HUD-canon FloatingMenu / Combobox: a caret-anchored popover reused by the
// `/` (SlashMenu) and `@` (MentionMenu) chat surfaces. The HUD has no overlay
// primitive; this is the one. Styled to canon (charcoal #101217 surface, amber
// #ffb000 active row, JetBrains Mono rows, uppercase group headers). The OWNER of
// the item list / filtering / selection is the caller — this component only renders
// the popover, paints the active row, wires click-outside, and forwards clicks.
// Keyboard nav (arrow/enter/escape) is owned by the caller's input via `activeIndex`
// + `onPick`/`onClose`, because the trigger char lives in the caller's <textarea>.
// ─────────────────────────────────────────────────────────────────────────────

/** One selectable row. `group` headers render in first-appearance order. */
export interface FloatingItem {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** optional right-aligned trailing note (e.g. an arg-hint chip). */
  trailing?: React.ReactNode;
  group?: string;
}

export function FloatingMenu({
  open,
  items,
  activeIndex,
  onPick,
  onClose,
  emptyText = 'no matches',
  header,
  footer,
  className = '',
}: {
  open: boolean;
  items: FloatingItem[];
  /** index into the FLAT `items` array of the currently-highlighted row. */
  activeIndex: number;
  onPick: (item: FloatingItem, index: number) => void;
  onClose: () => void;
  emptyText?: string;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // click-outside dismiss — mirrors MultiPicker's mousedown listener
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);

  // scroll the active row into view as the caller moves the selection
  React.useEffect(() => {
    if (!open || !rootRef.current) return;
    const el = rootRef.current.querySelector(`[data-idx="${activeIndex}"]`) as HTMLElement | null;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  if (!open) return null;

  // group → rows, preserving first-appearance group order ('' = ungrouped). We keep
  // each row's FLAT index so the caller's activeIndex (over the flat list) lines up.
  const grouped: Array<[string, Array<{ item: FloatingItem; idx: number }>]> = [];
  const seen = new Map<string, Array<{ item: FloatingItem; idx: number }>>();
  items.forEach((item, idx) => {
    const g = item.group ?? '';
    if (!seen.has(g)) {
      const bucket: Array<{ item: FloatingItem; idx: number }> = [];
      seen.set(g, bucket);
      grouped.push([g, bucket]);
    }
    seen.get(g)!.push({ item, idx });
  });

  return (
    <div
      ref={rootRef}
      data-floating-menu
      className={`absolute left-0 bottom-full mb-1 z-50 w-full border border-line2 overflow-auto ${className}`}
      style={{ background: '#101217', maxHeight: 280, boxShadow: '0 -12px 32px -8px rgba(0,0,0,0.8)' }}
    >
      {header && <div className="px-3 py-1.5 border-b hairline font-mono text-[10px] text-faint">{header}</div>}
      {items.length === 0 && <div className="px-3 py-2 font-mono text-[11px] text-faint">{emptyText}</div>}
      {grouped.map(([group, rows]) => (
        <div key={group || '∅'}>
          {group && (
            <div
              data-group-header
              className="px-3 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.18em] text-faint sticky top-0"
              style={{ background: '#101217' }}
            >
              {group}
            </div>
          )}
          {rows.map(({ item, idx }) => {
            const active = idx === activeIndex;
            return (
              <button
                key={item.id}
                type="button"
                data-menu-item
                data-idx={idx}
                // onMouseDown (not onClick) so the row fires BEFORE the textarea blurs
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(item, idx);
                }}
                className="w-full text-left px-3 py-1.5 font-mono text-[11.5px] flex items-baseline gap-2"
                style={{
                  color: active ? '#ffb000' : '#e9e7df',
                  background: active ? 'rgba(255,176,0,0.10)' : 'transparent',
                }}
              >
                <span className="shrink-0">{item.label}</span>
                {item.hint && <span className="text-faint text-[10px] truncate flex-1">{item.hint}</span>}
                {item.trailing && <span className="text-faint text-[10px] shrink-0 ml-auto">{item.trailing}</span>}
              </button>
            );
          })}
        </div>
      ))}
      {footer && <div className="px-3 py-1.5 border-t hairline font-mono text-[10px] text-faint">{footer}</div>}
    </div>
  );
}
