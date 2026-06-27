'use client';
/**
 * Client-only chat UI preferences, persisted in one localStorage blob.
 * Ceiling: per-browser, not synced across devices (YAGNI — server-sync deferred).
 * All access is try/catch + SSR-safe (matches Shell.tsx's localStorage pattern).
 */
const KEY = 'fleet:chatPrefs';

type Prefs = {
  pins?: string[];
  width?: number;
  collapsed?: boolean;
  drafts?: Record<string, string>;
};

function read(): Prefs {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Prefs;
  } catch {
    return {};
  }
}

function write(p: Prefs): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode / quota — ignore */
  }
}

export const chatPrefs = {
  getPins(): Set<string> {
    return new Set(read().pins ?? []);
  },
  isPinned(id: string): boolean {
    return (read().pins ?? []).includes(id);
  },
  togglePin(id: string): void {
    const p = read();
    const pins = new Set(p.pins ?? []);
    if (pins.has(id)) pins.delete(id);
    else pins.add(id);
    write({ ...p, pins: [...pins] });
  },

  getWidth(): number | null {
    return read().width ?? null;
  },
  setWidth(px: number): void {
    write({ ...read(), width: px });
  },

  getCollapsed(): boolean {
    return !!read().collapsed;
  },
  setCollapsed(b: boolean): void {
    write({ ...read(), collapsed: b });
  },

  getDraft(id: string): string {
    return (read().drafts ?? {})[id] ?? '';
  },
  setDraft(id: string, text: string): void {
    const p = read();
    const drafts = { ...(p.drafts ?? {}) };
    if (text) drafts[id] = text;
    else delete drafts[id];
    write({ ...p, drafts });
  },
  clearDraft(id: string): void {
    this.setDraft(id, '');
  },
};
