'use client';
import React, { useRef, useState, useLayoutEffect, useEffect } from 'react';
// ponytail: Btn/Textarea not used — composer renders raw elements for full style control

import type { ChatAttachment, CommandDef, RunEngine } from '@fleet/shared';
import { SlashMenu, ArgMenu } from '@/components/SlashMenu';
import { MentionMenu } from '@/components/MentionMenu';
import { api } from '@/lib/api';
import { chatPrefs } from '@/lib/chatPrefs';

/** What the caret is currently "inside": a `/` command token at input start, or an
 *  `@` mention token. `start` is the index of the trigger char; `query` is the text
 *  between the trigger and the caret. Returns null when no menu should be open. */
export type TriggerMatch =
  | { kind: 'slash'; query: string; start: number }
  /** Task 4.1 — second-stage: caret is inside an arg token of a fully-typed command. */
  | { kind: 'slash-arg'; commandName: string; argIndex: number; query: string; start: number }
  | { kind: 'mention'; query: string; start: number };

export function detectTrigger(text: string, caret: number): TriggerMatch | null {
  const upto = text.slice(0, caret);
  if (upto.startsWith('/')) {
    const afterSlash = upto.slice(1);
    const spaceIdx = afterSlash.indexOf(' ');
    if (spaceIdx < 0) {
      // Still typing the command name (no space yet)
      return { kind: 'slash', query: afterSlash, start: 0 };
    }
    // Caret is inside an argument of an already-typed command
    const commandName = afterSlash.slice(0, spaceIdx);
    const afterName = afterSlash.slice(spaceIdx + 1);
    const argParts = afterName.split(' ');
    const argIndex = argParts.length - 1;
    const query = argParts[argIndex];
    return { kind: 'slash-arg', commandName, argIndex, query, start: upto.length - query.length };
  }
  // mention: the `@` must START the token immediately left of the caret. Find the
  // last whitespace before the caret; the token after it must begin with `@`.
  const ws = Math.max(upto.lastIndexOf(' '), upto.lastIndexOf('\n'), upto.lastIndexOf('\t'));
  const tokenStart = ws + 1;
  const token = upto.slice(tokenStart);
  if (token.startsWith('@')) {
    const q = token.slice(1);
    if (!/\s/.test(q)) return { kind: 'mention', query: q, start: tokenStart };
  }
  return null;
}

export function ChatComposer({
  disabled,
  running,
  engine = 'claude',
  cwd,
  sessionId,
  onSend,
  onCommand,
  onStop,
}: {
  disabled: boolean;
  /** §7 — a turn is currently streaming; swap the send affordance for Stop. */
  running: boolean;
  /** §12 D8 — engine type; Stop is only shown for claude (one-shot engines have no live process). */
  engine?: RunEngine;
  /** §6 — session workspace label (slash-command context). The `@` file search no longer trusts
   *  this client value: its root is resolved server-side from `sessionId` (fix 10B). */
  cwd: string;
  /** §6 — pins the `@` file search to the session's server-trusted workspace root (fix 10B). */
  sessionId?: string | null;
  /** plain message + its `@` attachments. */
  onSend: (message: string, attachments: ChatAttachment[]) => void;
  /** a `/command` line (verbatim, leading slash kept). */
  onCommand: (line: string) => void;
  /** §7 — Stop the streaming turn. */
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [caret, setCaret] = useState(0);
  // §fix09 — explicit menu dismissal. Escape/click-outside set this true; the next
  // keystroke/onChange clears it. `detectTrigger` is consulted only when !dismissed,
  // so a dismissed menu does NOT immediately re-open on the same text.
  const [dismissed, setDismissed] = useState(false);
  // §fix09 — count of selectable rows in the open menu. Enter is "owned" by the menu
  // (and must not submit) only while it has at least one pickable row — mirroring each
  // menu's own `if (rows[active])` Enter guard. An open-but-empty menu lets Enter submit.
  const [menuCount, setMenuCount] = useState(0);
  // §fix10C — combobox wiring: the open menu reports its listbox id + active option id so the
  // textarea (role=combobox) can point aria-controls / aria-activedescendant at the live listbox.
  const [aria, setAria] = useState<{ listboxId: string; activeOptionId: string | null }>({ listboxId: '', activeOptionId: null });
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Task 4.1 — commands catalog (fetched once; used for arg-completion type lookup)
  const [cmds, setCmds] = useState<CommandDef[]>([]);
  // Task 4.1 — resolved arg values for the current slash-arg trigger (null = n/a; [] = no values)
  const [argValues, setArgValues] = useState<{ value: string; label?: string }[] | null>(null);

  // Per-session draft: load this session's saved draft when the session changes. Persistence
  // happens on explicit edits (onChange/replaceToken) so this load never clobbers a draft.
  useEffect(() => {
    setText(sessionId ? chatPrefs.getDraft(sessionId) : '');
    setCaret(0);
    setDismissed(false);
    if (sessionId) taRef.current?.focus(); // autofocus when a session opens
  }, [sessionId]);

  // auto-grow: reset to single-row height then grow to scrollHeight (capped)
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
  }, [text]);

  const trigger = dismissed ? null : detectTrigger(text, caret);
  // a menu "owns" Enter only when it is open AND has a row to pick (else Enter submits).
  const menuOpen = trigger !== null && menuCount > 0;

  // ponytail: load commands catalog lazily on first slash trigger, not on every composer mount.
  // cmdsLoadedRef prevents re-fetching when the user closes and reopens the slash menu.
  const cmdsLoadedRef = useRef(false);
  const slashActive = trigger?.kind === 'slash' || trigger?.kind === 'slash-arg';
  useEffect(() => {
    if (!slashActive || cmdsLoadedRef.current) return;
    cmdsLoadedRef.current = true;
    api.listCommands().then(setCmds).catch(() => {});
  }, [slashActive]);

  // Task 4.1 — resolve arg values when the slash-arg trigger changes.
  // Static enum args resolve client-side; dynamic (source) args call api.commandArgs once per (command, argIndex).
  const slashArg = trigger?.kind === 'slash-arg' ? trigger : null;
  useEffect(() => {
    if (!slashArg) { setArgValues(null); return; }
    const { commandName, argIndex } = slashArg;
    const cmd = cmds.find((c) => c.name === commandName);
    const arg = cmd?.args[argIndex];
    if (!arg) { setArgValues([]); return; }
    if (arg.type === 'enum' && arg.enum) { setArgValues(arg.enum.map((v) => ({ value: v }))); return; }
    if (arg.source && sessionId) {
      let alive = true;
      api.commandArgs(commandName, sessionId, argIndex)
        .then((vals) => { if (alive) setArgValues(vals); })
        .catch(() => { if (alive) setArgValues([]); });
      return () => { alive = false; };
    }
    setArgValues([]);
  // ponytail: cmds in deps is the stable state ref (only updates on setCmds)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashArg?.commandName, slashArg?.argIndex, cmds, sessionId]);

  function reset() {
    setText('');
    setAttachments([]);
    setCaret(0);
    setDismissed(false);
    if (sessionId) chatPrefs.clearDraft(sessionId);
  }

  function submit() {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('/')) {
      onCommand(t);
    } else {
      onSend(t, attachments);
    }
    reset();
  }

  /** Replace the active trigger token (from `start` to caret) with `insert`. */
  function replaceToken(start: number, insert: string) {
    const before = text.slice(0, start);
    const after = text.slice(caret);
    const next = before + insert + after;
    setText(next);
    if (sessionId) chatPrefs.setDraft(sessionId, next);
    const pos = (before + insert).length;
    setCaret(pos);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }

  function addAttachment(a: ChatAttachment, tokenStart: number) {
    // drop the `@query` token, keep the chip in the row
    replaceToken(tokenStart, '');
    setAttachments((prev) => (prev.some((p) => p.path === a.path) ? prev : [...prev, a]));
  }

  function pickCommand(name: string) {
    // replace the `/query` with `/<name> ` ready for args
    replaceToken(0, `/${name} `);
  }

  return (
    <div className="bg-[#16181d] border border-white/[0.08] rounded-2xl p-3">
      {/* attachment chips row (§6.2) — restyled as blue rounded pills */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a) => (
            <span
              key={a.path}
              data-chip
              className="inline-flex items-center gap-1 font-sans text-[11px] px-2 py-0.5 rounded-full bg-[#4f7fff]/15 text-[#4f7fff] border border-[#4f7fff]/25"
            >
              {a.kind === 'dir' ? '▣' : '▦'} {a.path}
              <button
                type="button"
                className="text-[#4f7fff]/50 hover:text-[#4f7fff] leading-none ml-0.5 transition-colors"
                onClick={() => setAttachments((prev) => prev.filter((p) => p.path !== a.path))}
                title={`remove ${a.path}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {/* textarea + floating menus (menus are absolute bottom-full within this relative wrapper) */}
      <div className="relative">
        {/* `/` palette — first stage: pick a command */}
        {trigger?.kind === 'slash' && (
          <SlashMenu
            query={trigger.query}
            cwd={cwd}
            onPick={(name: string) => pickCommand(name)}
            onClose={() => setDismissed(true)}
            onCount={setMenuCount}
            onActiveDescendant={setAria}
          />
        )}
        {/* Task 4.1 — second stage: pick an arg value after the command name is chosen */}
        {trigger?.kind === 'slash-arg' && argValues !== null && argValues.length > 0 && (
          <ArgMenu
            values={argValues}
            query={trigger.query}
            onPick={(value) => replaceToken(trigger.start, value + ' ')}
            onClose={() => setDismissed(true)}
            onCount={setMenuCount}
            onActiveDescendant={setAria}
          />
        )}
        {/* `@` picker — only mountable once we have a session to scope the server-side search */}
        {trigger?.kind === 'mention' && sessionId && (
          <MentionMenu
            query={trigger.query}
            sessionId={sessionId}
            onPick={(att: ChatAttachment) => addAttachment(att, trigger.start)}
            onClose={() => setDismissed(true)}
            onCount={setMenuCount}
            onActiveDescendant={setAria}
          />
        )}

        {/* ponytail: raw textarea instead of <Textarea> to escape the mono/amber base styles
            from ui.tsx — all handlers, aria attrs, and ref are identical. */}
        <textarea
          ref={taRef}
          rows={3}
          value={text}
          disabled={disabled}
          placeholder="Message…  (/ for commands · @ to attach)"
          // §fix10C — combobox: the textarea drives an open `/`-or-`@` listbox. aria-controls /
          // aria-activedescendant point at the live menu so SR users hear the highlighted row.
          role="combobox"
          aria-expanded={menuOpen}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={menuOpen && aria.listboxId ? aria.listboxId : undefined}
          aria-activedescendant={menuOpen && aria.activeOptionId ? aria.activeOptionId : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            if (sessionId) chatPrefs.setDraft(sessionId, e.target.value);
            // a new keystroke clears an Escape/click-outside dismissal (§fix09)
            setDismissed(false);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter force-submits even when a `/` or `@` menu is open.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
              return;
            }
            // Enter while a `/` or `@` trigger menu is open must NEVER submit — the menu
            // owns Enter (it picks the active row + stopPropagation). Only submit when closed.
            if (e.key === 'Enter' && !e.shiftKey && !menuOpen) {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full bg-transparent resize-none overflow-auto outline-none text-[#e9e7df] font-sans text-sm placeholder:text-[#5b626d] leading-relaxed disabled:opacity-50"
          style={{ maxHeight: 320 }}
        />
      </div>

      {/* bottom tool row: attach · engine hint · send/stop */}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-1.5">
          {/* '+' inserts an `@` token → opens the MentionMenu file picker (a leading space first
              when needed so `@` starts its own token, which is what detectTrigger requires). */}
          <button
            type="button"
            title="Attach file"
            onClick={() => {
              const needsSpace = text.length > 0 && !/\s$/.test(text);
              const next = text + (needsSpace ? ' @' : '@');
              setText(next);
              if (sessionId) chatPrefs.setDraft(sessionId, next);
              setCaret(next.length);
              setDismissed(false);
              requestAnimationFrame(() => {
                const ta = taRef.current;
                if (ta) { ta.focus(); ta.setSelectionRange(next.length, next.length); }
              });
            }}
            className="w-7 h-7 rounded-full flex items-center justify-center text-[#9aa1ab] hover:text-[#e9e7df] hover:bg-white/5 transition-colors text-lg leading-none select-none"
          >
            +
          </button>
          <span className="font-sans text-[11px] text-[#5b626d] select-none">{engine}</span>
        </div>

        {/* Stop maps to .../interrupt — only meaningful for a live, running Claude turn (spec §7, §12 D8). */}
        {running && engine === 'claude' ? (
          <span data-stop>
            <button
              type="button"
              onClick={onStop}
              title="Stop generating"
              className="px-3 py-1 rounded-lg font-sans text-xs bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/25 transition-colors"
            >
              ■ Stop
            </button>
          </span>
        ) : (
          <span data-send>
            <button
              type="button"
              onClick={submit}
              disabled={disabled || !text.trim()}
              title="Send"
              className="w-8 h-8 rounded-full flex items-center justify-center bg-[#4f7fff] hover:bg-[#4f7fff]/90 text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {/* paper-plane send icon */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
