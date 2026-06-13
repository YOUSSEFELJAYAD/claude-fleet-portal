/**
 * Real tests for the pure web/lib formatters & status helpers. These have no DOM/React
 * dependency, so they run under the server's vitest harness via a relative import
 * (apps/web has no test runner of its own). Covers format.ts (usd/tokens/dur/ago/clock/
 * shortId), status.ts (statusMeta/nodeStatusColor/effortMeta/campaign+taskStatusColor),
 * and shiki.ts resolveLang.
 */
import { describe, it, expect } from 'vitest';
import { usd, tokens, dur, ago, clock, shortId } from '../../web/lib/format.js';
import { statusMeta, nodeStatusColor, effortMeta, campaignStatusColor, taskStatusColor } from '../../web/lib/status.js';
import { resolveLang } from '../../web/lib/shiki.js';

describe('format.usd', () => {
  it('renders an em-dash for null/undefined and $0.00 for zero', () => {
    expect(usd(null)).toBe('—');
    expect(usd(undefined)).toBe('—');
    expect(usd(0)).toBe('$0.00');
  });
  it('picks precision by magnitude', () => {
    expect(usd(0.0004)).toBe('$0.0004'); // < 0.01 → 4 dp
    expect(usd(1.5)).toBe('$1.50');      // < 100 → 2 dp
    expect(usd(250)).toBe('$250');       // >= 100 → 0 dp
  });
});

describe('format.tokens', () => {
  it('formats raw / k / M scales', () => {
    expect(tokens(null)).toBe('—');
    expect(tokens(999)).toBe('999');
    expect(tokens(1500)).toBe('1.5k');   // < 10k → 1 dp
    expect(tokens(42000)).toBe('42k');   // >= 10k → 0 dp
    expect(tokens(2_500_000)).toBe('2.50M');
  });
});

describe('format.dur', () => {
  it('renders s / m s / h m', () => {
    expect(dur(null)).toBe('—');
    expect(dur(-1)).toBe('—');
    expect(dur(5000)).toBe('5s');
    expect(dur(90_000)).toBe('1m 30s');
    expect(dur(3_660_000)).toBe('1h 1m');
  });
});

describe('format.ago', () => {
  it('renders relative time buckets', () => {
    expect(ago(null)).toBe('—');
    expect(ago(Date.now() - 2000)).toBe('now');        // < 5s
    expect(ago(Date.now() - 65_000)).toBe('1m ago');
    expect(ago(Date.now() - 2 * 3_600_000)).toBe('2h ago');
    expect(ago(Date.now() - 3 * 86_400_000)).toBe('3d ago');
  });
});

describe('format.clock & shortId', () => {
  it('clock renders HH:MM:SS (24h) or em-dash', () => {
    expect(clock(null)).toBe('—');
    expect(clock(Date.now())).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it('shortId strips the toolu_ prefix and caps at 8 chars', () => {
    expect(shortId(null)).toBe('—');
    expect(shortId('toolu_0123456789')).toBe('01234567');
    expect(shortId('abcdefghij')).toBe('abcdefgh');
  });
});

describe('status.statusMeta', () => {
  it('maps each known run status with a live flag', () => {
    expect(statusMeta('running')).toMatchObject({ label: 'RUNNING', live: true });
    expect(statusMeta('completed')).toMatchObject({ label: 'COMPLETED', live: false });
    expect(statusMeta('awaiting-permission').live).toBe(true);
  });
  it('falls back for an unknown status', () => {
    expect(statusMeta('weird' as any)).toMatchObject({ label: 'WEIRD', live: false });
  });
});

describe('status colors', () => {
  it('nodeStatusColor maps known + falls back', () => {
    expect(nodeStatusColor('completed')).toBe('#54e08a');
    expect(nodeStatusColor('zzz' as any)).toBe('#7b828c');
  });
  it('campaignStatusColor & taskStatusColor map known + fall back', () => {
    expect(campaignStatusColor('running')).toBe('#ffb000');
    expect(campaignStatusColor('???')).toBe('#7b828c');
    expect(taskStatusColor('completed')).toBe('#54e08a');
    expect(taskStatusColor('???')).toBe('#7b828c');
  });
});

describe('status.effortMeta', () => {
  it('uppercases the label and ranks heat (unknown → 2)', () => {
    expect(effortMeta('low')).toEqual({ label: 'LOW', hot: 0 });
    expect(effortMeta('max')).toEqual({ label: 'MAX', hot: 4 });
    expect(effortMeta('mystery')).toEqual({ label: 'MYSTERY', hot: 2 });
  });
});

describe('shiki.resolveLang', () => {
  it('defaults to text for empty/unknown hints', () => {
    expect(resolveLang(null)).toBe('text');
    expect(resolveLang('')).toBe('text');
    expect(resolveLang('  ')).toBe('text');
    expect(resolveLang('not-a-real-language')).toBe('text');
  });
  it('passes through a loaded grammar name, normalizing case + leading dot', () => {
    expect(resolveLang('typescript')).toBe('typescript');
    expect(resolveLang('.CSS')).toBe('css');
    expect(resolveLang('  Bash ')).toBe('bash');
  });
});
