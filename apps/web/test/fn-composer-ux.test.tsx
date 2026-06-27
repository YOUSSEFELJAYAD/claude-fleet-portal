import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  api: new Proxy({}, { get: () => vi.fn(async () => []) }),
}));

import { ChatComposer } from '../components/ChatComposer';
import { chatPrefs } from '../lib/chatPrefs';

const props = {
  disabled: false, running: false, engine: 'claude' as const, cwd: '/w',
  onSend: vi.fn(), onCommand: vi.fn(), onStop: vi.fn(),
};

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe('ChatComposer — UX', () => {
  it('persists the draft per session and clears it on submit', () => {
    const onSend = vi.fn();
    render(<ChatComposer {...props} sessionId="s1" onSend={onSend} />);
    const ta = screen.getByRole('combobox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello world' } });
    expect(chatPrefs.getDraft('s1')).toBe('hello world');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalled();
    expect(chatPrefs.getDraft('s1')).toBe('');
  });

  it('pre-fills a stored draft on mount', () => {
    chatPrefs.setDraft('s2', 'restored text');
    render(<ChatComposer {...props} sessionId="s2" />);
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('restored text');
  });

  it('Cmd/Ctrl+Enter submits', () => {
    const onSend = vi.fn();
    render(<ChatComposer {...props} sessionId="s1" onSend={onSend} />);
    const ta = screen.getByRole('combobox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hi' } });
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith('hi', expect.anything());
  });

  it('the + attach button inserts @ to open the file picker', () => {
    render(<ChatComposer {...props} sessionId="s1" />);
    fireEvent.click(screen.getByTitle(/attach/i));
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toContain('@');
  });
});
