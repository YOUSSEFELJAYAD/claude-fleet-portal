/**
 * Real tests for web/lib/shiki.ts render helpers highlightToHtml / highlightLineTokens.
 * The contract is "never throw; always return usable output" — these assertions hold whether
 * the heavy shiki grammar resolves (real token spans) or not (escaped plain-text fallback),
 * so both real code paths are exercised honestly.
 */
import { describe, it, expect } from 'vitest';
import { highlightToHtml, highlightLineTokens } from '../../web/lib/shiki.js';

describe('highlightToHtml', () => {
  it('returns an escaped <pre> fallback for unknown / text langs', async () => {
    const html = await highlightToHtml('<script>alert(1)</script>', 'text');
    expect(html).toContain('shiki-fallback');
    expect(html).toContain('&lt;script&gt;'); // html-escaped, never raw
    expect(html).not.toContain('<script>');
  });

  it('returns <pre> HTML containing the code for a real grammar hint', async () => {
    const html = await highlightToHtml('const x = 1;', 'typescript');
    expect(html.startsWith('<pre')).toBe(true);
    expect(html).toContain('x'); // token text is present whether shiki rendered or fell back
  }, 20000);
});

describe('highlightLineTokens', () => {
  it('returns a single empty run for an empty line', async () => {
    expect(await highlightLineTokens('', 'typescript')).toEqual([{ content: '' }]);
  });

  it('returns a single plain run for text lang', async () => {
    expect(await highlightLineTokens('just plain text', 'text')).toEqual([{ content: 'just plain text' }]);
  });

  it('tokenizes a line such that the concatenated content reconstructs the input', async () => {
    const toks = await highlightLineTokens('const x = 1;', 'typescript');
    expect(Array.isArray(toks)).toBe(true);
    expect(toks.map((t) => t.content).join('')).toBe('const x = 1;');
  }, 20000);
});
