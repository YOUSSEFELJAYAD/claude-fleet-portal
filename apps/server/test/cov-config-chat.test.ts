import { describe, it, expect } from 'vitest';
import { CHAT_LIVE_MAX, CHAT_IDLE_SUSPEND_MS } from '../src/config.js';

describe('chat config knobs', () => {
  it('CHAT_LIVE_MAX defaults to 4 and is a positive integer', () => {
    expect(CHAT_LIVE_MAX).toBe(4);
    expect(Number.isInteger(CHAT_LIVE_MAX)).toBe(true);
    expect(CHAT_LIVE_MAX).toBeGreaterThan(0);
  });

  it('CHAT_IDLE_SUSPEND_MS defaults to 600000 (10 minutes)', () => {
    expect(CHAT_IDLE_SUSPEND_MS).toBe(600_000);
    expect(Number.isFinite(CHAT_IDLE_SUSPEND_MS)).toBe(true);
  });
});
