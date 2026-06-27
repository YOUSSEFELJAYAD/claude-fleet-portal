import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// The page pulls live state + REST; stub both so we can assert layout structure only.
vi.mock('@/lib/live', () => ({
  useChatStream: () => ({ state: null, activeTurn: null, error: null, clearError: () => {} }),
  usePendingQuestions: () => ({ questions: [], refresh: () => {} }),
}));
vi.mock('@/lib/api', () => ({
  // Proxy: every api.* is an async fn resolving to [] — enough for mount (no active session).
  api: new Proxy({}, { get: () => vi.fn(async () => []) }),
}));

import ChatPage from '../app/chat/page';

describe('chat page — 20/80 two-column layout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a persistent sidebar region alongside the chat region (not a popover)', async () => {
    render(<ChatPage />);
    // The sessions sidebar is always visible as its own column.
    await waitFor(() => expect(screen.getByTestId('chat-sidebar')).toBeTruthy());
    // The session list panel lives inside the sidebar.
    const sidebar = screen.getByTestId('chat-sidebar');
    expect(sidebar.querySelector('[data-testid="chat-session-list"]')).toBeTruthy();
  });
});
