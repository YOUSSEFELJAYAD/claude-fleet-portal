/**
 * Shared FTS5 (SQLite full-text search) helpers.
 * Used by search.ts (run-transcript search) and future chat search.
 */
import type Database from 'better-sqlite3';

/**
 * CREATE VIRTUAL TABLE IF NOT EXISTS <table> USING fts5(<columns…>).
 * Columns may include FTS5 options, e.g. 'run_id UNINDEXED'.
 */
export function createFts(
  db: InstanceType<typeof Database>,
  table: string,
  columns: string[],
): void {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(${columns.join(', ')});`,
  );
}

/**
 * Sanitize a user query into a safe FTS5 MATCH expression.
 * Strips double-quotes and phrase-quotes the whole string so that
 * FTS5 operators (AND/OR/NOT/NEAR/*, parens) in user input don't throw.
 */
export function sanitizeFtsQuery(q: string): string {
  return `"${q.replace(/"/g, '')}"`;
}

/**
 * Returns the SQL `snippet()` call expression for the given FTS table + column.
 * Markup: <b>…</b>, ellipsis …, window 12 tokens — fleet's convention.
 */
export function ftsSnippet(table: string, colIdx: number): string {
  return `snippet(${table}, ${colIdx}, '<b>', '</b>', '…', 12)`;
}
