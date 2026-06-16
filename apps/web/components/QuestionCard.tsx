'use client';
import React, { useState } from 'react';
import { Btn, Kicker, Textarea, ErrorBanner } from './ui';
import { api } from '@/lib/api';

export interface QuestionData {
  id: string;
  sessionId: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  allowFreeText: boolean;
  createdAt: number;
}

export interface QuestionCardItem {
  kind: string;
  question?: QuestionData;
}

export function QuestionCard({ item, onAction }: { item: QuestionCardItem; onAction: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const q = item.question;

  async function submit(selection: string[]) {
    if (!q) return;
    setBusy(true);
    setErr(null);
    try {
      const body: { selection: string[]; text?: string } = { selection };
      if (q.allowFreeText && freeText) body.text = freeText;
      await api.answerQuestion(q.id, body);
      onAction();
    } catch (e: any) {
      setErr(e.message ?? 'Error');
    } finally {
      setBusy(false);
    }
  }

  function toggleOption(opt: string) {
    setSelected((prev) =>
      prev.includes(opt) ? prev.filter((o) => o !== opt) : [...prev, opt],
    );
  }

  function handleOptionClick(opt: string) {
    if (!q) return;
    if (q.multiSelect) {
      toggleOption(opt);
    } else {
      submit([opt]);
    }
  }

  if (!q) return null;

  return (
    <div className="border hairline bg-black/20 transition-colors hover:bg-white/[0.025]">
      <div className="p-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
          <div>
            <Kicker>question</Kicker>
            <div className="mt-2 font-mono text-[13px] text-ink leading-relaxed">
              {q.question}
            </div>

            {q.allowFreeText && (
              <div className="mt-4">
                <Kicker>additional context</Kicker>
                <Textarea
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  placeholder="Optional free-text response…"
                  disabled={busy}
                  rows={3}
                  className="mt-2 !text-[12px]"
                />
              </div>
            )}
          </div>

          <div className="border border-line2 bg-black/20 p-3 flex flex-col gap-3">
            <Kicker>options</Kicker>
            <div className="flex flex-col gap-2">
              {q.options.map((opt) => (
                <Btn
                  key={opt}
                  variant={q.multiSelect && selected.includes(opt) ? 'solid' : 'ghost'}
                  onClick={() => handleOptionClick(opt)}
                  disabled={busy}
                  className="justify-start !py-2"
                >
                  {opt}
                </Btn>
              ))}
            </div>
            {q.multiSelect && (
              <Btn
                variant="solid"
                onClick={() => submit(selected)}
                disabled={busy || selected.length === 0}
                className="justify-center !py-2 mt-1"
              >
                Submit
              </Btn>
            )}
          </div>
        </div>
        {err && <ErrorBanner className="mt-3">{err}</ErrorBanner>}
      </div>
    </div>
  );
}
