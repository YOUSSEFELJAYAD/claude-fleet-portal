import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/live', () => ({
  useChatStream: () => ({ state: null, activeTurn: null, error: null, clearError: () => {} }),
  usePendingQuestions: () => ({ questions: [], refresh: () => {} }),
}));
vi.mock('@/lib/api', () => ({
  api: new Proxy({}, { get: () => vi.fn(async () => []) }),
}));

import ChatPage from '../app/chat/page';

// Fullscreen = a fixed inset-0 overlay (covers the app chrome) + native Fullscreen API.
// jsdom has no requestFullscreen, so we assert the in-app mode flag toggles.
describe('chat page — fullscreen toggle', () => {
  it('toggles the fullscreen container mode on/off', async () => {
    const { container } = render(<ChatPage />);
    const root = container.querySelector('[data-testid="chat-root"]') as HTMLElement;
    expect(root.getAttribute('data-fullscreen')).toBe('false');

    const btn = await screen.findByLabelText(/fullscreen/i);
    fireEvent.click(btn);
    expect(root.getAttribute('data-fullscreen')).toBe('true');

    fireEvent.click(btn);
    expect(root.getAttribute('data-fullscreen')).toBe('false');
  });
});
