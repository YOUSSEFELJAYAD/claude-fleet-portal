'use client';
import { useState } from 'react';
import { Btn, Input } from '@/components/ui';

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
