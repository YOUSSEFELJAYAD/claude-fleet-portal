import { describe, it, expect, beforeEach } from 'vitest';
import { chatPrefs } from '../lib/chatPrefs';

beforeEach(() => localStorage.clear());

describe('chatPrefs (localStorage-backed chat UI prefs)', () => {
  it('togglePin round-trips through localStorage', () => {
    expect(chatPrefs.isPinned('a')).toBe(false);
    chatPrefs.togglePin('a');
    expect(chatPrefs.isPinned('a')).toBe(true);
    expect([...chatPrefs.getPins()]).toContain('a');
    chatPrefs.togglePin('a');
    expect(chatPrefs.isPinned('a')).toBe(false);
  });

  it('persists sidebar width', () => {
    expect(chatPrefs.getWidth()).toBeNull();
    chatPrefs.setWidth(320);
    expect(chatPrefs.getWidth()).toBe(320);
  });

  it('persists the collapsed flag', () => {
    expect(chatPrefs.getCollapsed()).toBe(false);
    chatPrefs.setCollapsed(true);
    expect(chatPrefs.getCollapsed()).toBe(true);
  });

  it('stores and clears per-session drafts', () => {
    expect(chatPrefs.getDraft('s1')).toBe('');
    chatPrefs.setDraft('s1', 'hello');
    expect(chatPrefs.getDraft('s1')).toBe('hello');
    chatPrefs.clearDraft('s1');
    expect(chatPrefs.getDraft('s1')).toBe('');
  });
});
