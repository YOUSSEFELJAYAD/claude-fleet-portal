'use client';
import React, { useRef, useState, useLayoutEffect } from 'react';
import { Btn, Textarea } from '@/components/ui';
import type { ChatAttachment, RunEngine } from '@fleet/shared';
import { SlashMenu } from '@/components/SlashMenu';
import { MentionMenu } from '@/components/MentionMenu';

/** What the caret is currently "inside": a `/` command token at input start, or an
 *  `@` mention token. `start` is the index of the trigger char; `query` is the text
 *  between the trigger and the caret. Returns null when no menu should be open. */
export type TriggerMatch =
  | { kind: 'slash'; query: string; start: number }
  | { kind: 'mention'; query: string; start: number };

export function detectTrigger(text: string, caret: number): TriggerMatch | null {
  const upto = text.slice(0, caret);
  // slash: only at the very start of the input, no whitespace after the verb yet
  if (upto.startsWith('/')) {
    const seg = upto.slice(1);
    if (!/\s/.test(seg)) return { kind: 'slash', query: seg, start: 0 };
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
  onSend,
  onCommand,
  onStop,
}: {
  disabled: boolean;
  /** §7 — a turn is currently streaming; swap the send affordance for Stop. */
  running: boolean;
  /** §12 D8 — engine type; Stop is only shown for claude (one-shot engines have no live process). */
  engine?: RunEngine;
  /** §6 — session workspace, scopes the `@` file search. */
  cwd: string;
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
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // auto-grow: reset to single-row height then grow to scrollHeight (capped)
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [text]);

  const trigger = dismissed ? null : detectTrigger(text, caret);
  // a menu "owns" Enter only when it is open AND has a row to pick (else Enter submits).
  const menuOpen = trigger !== null && menuCount > 0;

  function reset() {
    setText('');
    setAttachments([]);
    setCaret(0);
    setDismissed(false);
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
    <div className="border-t hairline p-3">
      {/* attachment chips row (§6.2) */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((a) => (
            <span
              key={a.path}
              data-chip
              className="inline-flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 border text-amber border-amber/45 bg-amber/8"
            >
              {a.kind === 'dir' ? '▣' : '▦'} {a.path}
              <button
                type="button"
                className="text-faint hover:text-ink leading-none"
                onClick={() => setAttachments((prev) => prev.filter((p) => p.path !== a.path))}
                title={`remove ${a.path}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative flex gap-2 items-end">
        {/* `/` palette */}
        {trigger?.kind === 'slash' && (
          <SlashMenu
            query={trigger.query}
            cwd={cwd}
            onPick={(name: string) => pickCommand(name)}
            onClose={() => setDismissed(true)}
            onCount={setMenuCount}
          />
        )}
        {/* `@` picker */}
        {trigger?.kind === 'mention' && (
          <MentionMenu
            query={trigger.query}
            cwd={cwd}
            onPick={(att: ChatAttachment) => addAttachment(att, trigger.start)}
            onClose={() => setDismissed(true)}
            onCount={setMenuCount}
          />
        )}

        <Textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="Message…  (/ for commands · @ to attach)"
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            // a new keystroke clears an Escape/click-outside dismissal (§fix09)
            setDismissed(false);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            // Enter while a `/` or `@` trigger menu is open must NEVER submit — the menu
            // owns Enter (it picks the active row + stopPropagation). Only submit when closed.
            if (e.key === 'Enter' && !e.shiftKey && !menuOpen) {
              e.preventDefault();
              submit();
            }
          }}
          className="flex-1 resize-none overflow-auto"
          style={{ maxHeight: 200 }}
        />

        {/* Stop maps to .../interrupt — only meaningful for a live, running Claude turn (spec §7, §12 D8). */}
        {running && engine === 'claude' ? (
          <span data-stop>
            <Btn variant="danger" onClick={onStop} title="Stop generating">■ Stop</Btn>
          </span>
        ) : (
          <span data-send>
            <Btn
              variant="solid"
              onClick={submit}
              disabled={disabled || !text.trim()}
              title="Send"
            >
              ▶
            </Btn>
          </span>
        )}
      </div>
    </div>
  );
}
