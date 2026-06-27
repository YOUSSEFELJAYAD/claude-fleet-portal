import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/live', () => ({
  useChatStream: () => ({ state: null, activeTurn: null, error: null, clearError: () => {} }),
  usePendingQuestions: () => ({ questions: [], refresh: () => {} }),
}));
vi.mock('@/lib/api', () => ({ api: new Proxy({}, { get: () => vi.fn(async () => []) }) }));

import ChatPage from '../app/chat/page';
import { chatPrefs } from '../lib/chatPrefs';

describe('chat sidebar — collapse + resize', () => {
  it('collapse toggle rails the sidebar and persists; expand restores', async () => {
    render(<ChatPage />);
    const aside = await screen.findByTestId('chat-sidebar');
    expect(aside.getAttribute('data-collapsed')).toBe('false');

    fireEvent.click(screen.getByLabelText(/collapse sidebar/i));
    expect(aside.getAttribute('data-collapsed')).toBe('true');
    expect(chatPrefs.getCollapsed()).toBe(true);

    fireEvent.click(screen.getByLabelText(/expand sidebar/i));
    expect(aside.getAttribute('data-collapsed')).toBe('false');
    expect(chatPrefs.getCollapsed()).toBe(false);
  });

  it('dragging the divider resizes the sidebar and persists the width', async () => {
    render(<ChatPage />);
    const aside = await screen.findByTestId('chat-sidebar');
    fireEvent.pointerDown(screen.getByTestId('sidebar-resize'), { clientX: 250 });
    fireEvent.pointerMove(document.body, { clientX: 420 });
    fireEvent.pointerUp(document.body, { clientX: 420 });
    expect(aside.style.width).toBe('420px');
    expect(chatPrefs.getWidth()).toBe(420);
  });
});
