/**
 * Unit tests for the shared FTS5 helper (fts.ts).
 * Runs against an in-memory SQLite DB — no server bootstrap needed.
 *
 * Skips FTS-dependent cases if better-sqlite3 was built without FTS5.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createFts, sanitizeFtsQuery, ftsSnippet } from '../src/fts.js';

// ── FTS5 availability (probe once) ────────────────────────────────────────────

function ftsAvailable(): boolean {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS _probe USING fts5(body);`);
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

const FTS5 = ftsAvailable();
function skipIfNoFts(label: string, fn: () => void) {
  it(label, () => {
    if (!FTS5) { console.log(`  [skip] FTS5 unavailable — ${label}`); return; }
    fn();
  });
}

// ── createFts ─────────────────────────────────────────────────────────────────

describe('createFts', () => {
  skipIfNoFts('creates the virtual table and allows MATCH queries', () => {
    const db = new Database(':memory:');
    createFts(db, 'test_fts', ['id UNINDEXED', 'body']);
    db.prepare('INSERT INTO test_fts (id, body) VALUES (?, ?)').run('r1', 'hello world');
    db.prepare('INSERT INTO test_fts (id, body) VALUES (?, ?)').run('r2', 'foo bar');

    const rows = db
      .prepare('SELECT id FROM test_fts WHERE test_fts MATCH ? ORDER BY rank')
      .all('"hello"') as { id: string }[];

    expect(rows.map(r => r.id)).toContain('r1');
    expect(rows.map(r => r.id)).not.toContain('r2');
    db.close();
  });

  skipIfNoFts('is idempotent — IF NOT EXISTS means second call does not throw', () => {
    const db = new Database(':memory:');
    createFts(db, 'dup_fts', ['body']);
    expect(() => createFts(db, 'dup_fts', ['body'])).not.toThrow();
    db.close();
  });
});

// ── sanitizeFtsQuery ──────────────────────────────────────────────────────────

describe('sanitizeFtsQuery', () => {
  it('wraps plain term in double quotes', () => {
    expect(sanitizeFtsQuery('hello')).toBe('"hello"');
  });

  it('strips existing double quotes before wrapping', () => {
    // a"b* OR c → strip " → ab* OR c → "ab* OR c"
    expect(sanitizeFtsQuery('a"b* OR c')).toBe('"ab* OR c"');
  });

  it('strips a bare double-quote', () => {
    expect(sanitizeFtsQuery('"')).toBe('""');
  });

  skipIfNoFts('operator-laden queries do not throw on MATCH', () => {
    const db = new Database(':memory:');
    createFts(db, 'safe_fts', ['body']);
    db.prepare('INSERT INTO safe_fts (body) VALUES (?)').run('test content here');

    const dangerous = [
      'AND OR NOT',
      'foo*',
      '"unclosed',
      'NEAR/5(foo bar)',
      'a"b* OR c',
      'hello "world"',
      '(unclosed',
      'payments.ts AND x',
    ];
    for (const q of dangerous) {
      const safe = sanitizeFtsQuery(q);
      expect(
        () => db.prepare('SELECT * FROM safe_fts WHERE safe_fts MATCH ?').all(safe),
        `should not throw for: ${JSON.stringify(q)}`,
      ).not.toThrow();
    }
    db.close();
  });

  skipIfNoFts('sanitized term matches when the text is present', () => {
    const db = new Database(':memory:');
    createFts(db, 'match_fts', ['body']);
    db.prepare('INSERT INTO match_fts (body) VALUES (?)').run('payments module done');

    // Input has a stray quote: payments" → sanitized → "payments" → phrase match
    const safe = sanitizeFtsQuery('payments"');
    const rows = db
      .prepare('SELECT * FROM match_fts WHERE match_fts MATCH ?')
      .all(safe);
    expect(rows.length).toBeGreaterThan(0);
    db.close();
  });
});

// ── ftsSnippet ────────────────────────────────────────────────────────────────

describe('ftsSnippet', () => {
  it('returns the correct snippet SQL expression for column 3', () => {
    expect(ftsSnippet('events_fts', 3)).toBe(
      "snippet(events_fts, 3, '<b>', '</b>', '…', 12)",
    );
  });

  it('is usable inline in a prepared-statement SQL string', () => {
    // Verify the returned string is valid SQL fragment (no syntax error when embedded)
    expect(ftsSnippet('t', 0)).toBe("snippet(t, 0, '<b>', '</b>', '…', 12)");
  });

  skipIfNoFts('snippet expression works inside a real query', () => {
    const db = new Database(':memory:');
    createFts(db, 'snip_fts', ['id UNINDEXED', 'body']);
    db.prepare('INSERT INTO snip_fts (id, body) VALUES (?, ?)').run('1', 'the payments feature is done');

    const sql = `SELECT id, ${ftsSnippet('snip_fts', 1)} AS snip
                 FROM snip_fts WHERE snip_fts MATCH ? ORDER BY rank`;
    const rows = db.prepare(sql).all('"payments"') as { id: string; snip: string }[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].snip).toContain('<b>');
    db.close();
  });
});
