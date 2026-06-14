'use client';
import { useRef, useState, useLayoutEffect } from 'react';
import { Btn, Input } from '@/components/ui';
import type { ChatAttachment } from '@fleet/shared';

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

export function ChatComposer({ disabled, onSend, onCommand }: {
  disabled: boolean;
  onSend: (message: string) => void;
  onCommand: (line: string) => void;
}) {
  const [text, setText] = useState('');
  function submit() {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('/')) onCommand(t); else onSend(t);
    setText('');
  }
  return (
    <div className="border-t hairline p-3 flex gap-2">
      <Input value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Message…  (/ for commands)"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
      <Btn variant="solid" onClick={submit} disabled={disabled || !text.trim()}>▶</Btn>
    </div>
  );
}
