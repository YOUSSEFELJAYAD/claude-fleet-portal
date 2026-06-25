/**
 * detectTrigger(text, caret) — the composer's pure `/`+`@` detection. A `/` only
 * triggers the SlashMenu at the very start of the input (token-start = position 0);
 * an `@` triggers the MentionMenu when it starts a whitespace-delimited token. The
 * returned `query` is the chars between the trigger and the caret (no spaces).
 */
import { describe, it, expect } from 'vitest';
import { detectTrigger } from '../components/ChatComposer';

describe('detectTrigger — slash', () => {
  it('opens slash only at input start', () => {
    expect(detectTrigger('/kil', 4)).toEqual({ kind: 'slash', query: 'kil', start: 0 });
    expect(detectTrigger('/', 1)).toEqual({ kind: 'slash', query: '', start: 0 });
  });
  it('does NOT treat a mid-text slash as a command', () => {
    expect(detectTrigger('see src/a.ts', 12)).toBeNull();
    expect(detectTrigger('hi /kill', 8)).toBeNull(); // slash not at position 0
  });
  it('switches from slash to slash-arg once a space is typed after the verb (Task 4.1 arg completion)', () => {
    expect(detectTrigger('/kill ', 6)).toEqual({ kind: 'slash-arg', commandName: 'kill', argIndex: 0, query: '', start: 6 });
  });
});

describe('detectTrigger — mention', () => {
  it('opens mention when @ starts a whitespace-delimited token', () => {
    expect(detectTrigger('look at @src', 12)).toEqual({ kind: 'mention', query: 'src', start: 8 });
    expect(detectTrigger('@a', 2)).toEqual({ kind: 'mention', query: 'a', start: 0 });
  });
  it('does NOT trigger on an email-like @ in the middle of a token', () => {
    expect(detectTrigger('me@x.com', 8)).toBeNull();
  });
  it('closes mention when a space follows the path', () => {
    expect(detectTrigger('@src/a.ts ', 10)).toBeNull();
  });
  it('only considers the token immediately left of the caret', () => {
    expect(detectTrigger('@one @two', 4)).toEqual({ kind: 'mention', query: 'one', start: 0 });
  });
});
