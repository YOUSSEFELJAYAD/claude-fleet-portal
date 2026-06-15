/**
 * Fix 01 — registry must NOT auto-deliver an EMPTY prompt as turn-1 for interactive runs.
 *
 * The always-live model holds an interactive process born with an EMPTY prompt (it waits on
 * stdin); EVERY turn arrives via sendInput. So startProcess must only write the initial user
 * message when the launch prompt is actually non-empty — otherwise a held live process would
 * send a blank/garbage turn-1. This unit-tests the guard predicate in isolation (no spawn).
 */
import { describe, it, expect } from 'vitest';
import { shouldDeliverInitialPrompt } from '../src/registry.js';

describe('shouldDeliverInitialPrompt (fix 01: no empty turn-1 for interactive runs)', () => {
  it('interactive + non-empty prompt → delivers turn-1', () => {
    expect(shouldDeliverInitialPrompt(true, 'hi')).toBe(true);
  });

  it('interactive + empty prompt → does NOT deliver (held live process waits on stdin)', () => {
    expect(shouldDeliverInitialPrompt(true, '')).toBe(false);
  });

  it('interactive + whitespace-only prompt → does NOT deliver', () => {
    expect(shouldDeliverInitialPrompt(true, '   \n\t ')).toBe(false);
  });

  it('non-interactive → never delivers via this path (prompt is a positional arg)', () => {
    expect(shouldDeliverInitialPrompt(false, 'hi')).toBe(false);
    expect(shouldDeliverInitialPrompt(false, '')).toBe(false);
  });
});
