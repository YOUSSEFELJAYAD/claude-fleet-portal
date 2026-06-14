/**
 * ChatComposer Stop-button gating (spec §7, §12 D8): Stop maps to .../interrupt and is only
 * meaningful for a live, running Claude turn. An engine session has no interruptible process,
 * so Stop must never render for it — even while a turn is in flight.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatComposer } from '../components/ChatComposer';

const base = { disabled: false, onSend: vi.fn(), onCommand: vi.fn(), onStop: vi.fn() };

describe('ChatComposer — Stop gating by engine', () => {
  it('shows Stop for a running claude session', () => {
    render(<ChatComposer {...(base as any)} engine="claude" running={true} />);
    expect(screen.queryByText(/stop/i)).not.toBeNull();
  });
  it('never shows Stop for an engine session even when running', () => {
    render(<ChatComposer {...(base as any)} engine="codex" running={true} />);
    expect(screen.queryByText(/stop/i)).toBeNull();
  });
});
