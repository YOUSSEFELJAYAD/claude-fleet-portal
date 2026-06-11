'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * §23 — searchable multi-select dropdown: selected entries render as removable
 * chips, the inline input filters the option list, and (when allowCustom) any
 * free-form text can be added with Enter — needed for tool PATTERNS like
 * `Bash(git *)` or `mcp__server__tool` that no catalog can enumerate.
 */
export interface PickerOption {
  value: string;
  hint?: string;
  /** options render under group header rows, in first-appearance order */
  group?: string;
}

export function MultiPicker({
  value,
  onChange,
  options,
  placeholder = 'search…',
  allowCustom = true,
  customHint = 'add custom entry',
  emptyText = 'no matches',
}: {
  value: string[];
  onChange: (next: string[]) => void;
  options: PickerOption[];
  placeholder?: string;
  allowCustom?: boolean;
  customHint?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) => o.value.toLowerCase().includes(needle) || o.hint?.toLowerCase().includes(needle));
  }, [options, q]);

  // group → options, preserving first-appearance group order ('' = ungrouped)
  const grouped = useMemo(() => {
    const m = new Map<string, PickerOption[]>();
    for (const o of filtered) {
      const g = o.group ?? '';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(o);
    }
    return [...m.entries()];
  }, [filtered]);

  const selected = useMemo(() => new Set(value), [value]);
  const exactMatch = options.some((o) => o.value.toLowerCase() === q.trim().toLowerCase());
  const showCustom = allowCustom && q.trim() !== '' && !exactMatch && !selected.has(q.trim());

  const toggle = (v: string) => {
    onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  const addCustom = () => {
    const v = q.trim();
    if (!v) return;
    if (!selected.has(v)) onChange([...value, v]);
    setQ('');
  };

  return (
    <div ref={rootRef} className="relative">
      {/* control — chips + inline search */}
      <div
        className="w-full bg-black/40 border border-line2 px-2 py-1.5 flex flex-wrap items-center gap-1.5 cursor-text min-h-[38px] focus-within:border-amber/70"
        onClick={() => {
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        {value.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 border"
            style={{ borderColor: 'rgba(255,176,0,0.45)', color: '#ffb000', background: 'rgba(255,176,0,0.08)' }}
          >
            {v}
            <button
              type="button"
              className="text-faint hover:text-ink leading-none"
              onClick={(e) => {
                e.stopPropagation();
                toggle(v);
              }}
              title={`remove ${v}`}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Backspace' && q === '' && value.length) onChange(value.slice(0, -1));
            if (e.key === 'Enter') {
              e.preventDefault();
              // Enter picks the first MATCHING option; free-text only when nothing
              // matches (the "+ add" row stays clickable for deliberate custom entries)
              const first = filtered.find((o) => !selected.has(o.value));
              if (first) {
                toggle(first.value);
                setQ('');
              } else if (showCustom) addCustom();
            }
          }}
          placeholder={placeholder}
          className="flex-1 min-w-[120px] bg-transparent outline-none font-mono text-[12px] text-ink placeholder:text-faint py-0.5"
        />
        <span className="text-faint font-mono text-[10px] select-none">{open ? '▴' : '▾'}</span>
      </div>

      {/* dropdown */}
      {open && (
        <div
          className="absolute left-0 right-0 z-40 mt-1 border border-line2 overflow-auto"
          style={{ background: '#101217', maxHeight: 260, boxShadow: '0 12px 32px -8px rgba(0,0,0,0.8)' }}
        >
          {showCustom && (
            <button
              type="button"
              onClick={addCustom}
              className="w-full text-left px-3 py-2 font-mono text-[11.5px] hover:bg-amber/10 border-b hairline"
              style={{ color: '#ffb000' }}
            >
              ＋ add “{q.trim()}” <span className="text-faint">· {customHint}</span>
            </button>
          )}
          {grouped.length === 0 && !showCustom && (
            <div className="px-3 py-2 font-mono text-[11px] text-faint">{emptyText}</div>
          )}
          {grouped.map(([group, opts]) => (
            <div key={group || '∅'}>
              {group && (
                <div className="px-3 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.18em] text-faint sticky top-0" style={{ background: '#101217' }}>
                  {group}
                </div>
              )}
              {opts.map((o) => {
                const on = selected.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    title={o.hint}
                    className="w-full text-left px-3 py-1.5 font-mono text-[11.5px] flex items-baseline gap-2 hover:bg-white/[0.04]"
                    style={{ color: on ? '#ffb000' : '#e9e7df' }}
                  >
                    <span className="shrink-0">{on ? '◉' : '○'}</span>
                    <span className="shrink-0">{o.value}</span>
                    {o.hint && <span className="text-faint text-[10px] truncate">{o.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
