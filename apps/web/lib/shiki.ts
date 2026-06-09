/**
 * Lazy, singleton Shiki highlighter (v2 spec §4 #6).
 *
 * - ONE highlighter instance for the whole app, created on first use and cached as a
 *   module-level promise (so concurrent callers share the single async init).
 * - A small, fixed set of common langs + ONE built-in dark theme (`github-dark-default`).
 * - This module is itself only ever pulled in via a dynamic `import('@/lib/shiki')` from the
 *   client components (ShikiCode / MarkdownView / DiffView), so the heavy Shiki + Oniguruma
 *   wasm payload is code-split out of the initial page chunk and never blocks first paint.
 *
 * Safety contract: every public helper falls back to escaped plain text on an unknown lang or
 * any load/highlight failure — it NEVER throws to the caller.
 */
import type { BundledLanguage, BundledTheme, Highlighter, ThemedToken } from 'shiki';

export const SHIKI_THEME: BundledTheme = 'github-dark-default';

/** Common languages we preload. Anything outside this set degrades to plain `text`. */
const LANGS: BundledLanguage[] = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'jsonc',
  'css',
  'html',
  'markdown',
  'bash',
  'shell',
  'python',
  'go',
  'rust',
  'sql',
  'yaml',
  'toml',
  'diff',
];

/** ext / fence-info → Shiki language id. Unmapped → `'text'` (plain, no grammar). */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  geojson: 'json',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
  xml: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  shell: 'shell',
  py: 'python',
  python: 'python',
  go: 'go',
  rs: 'rust',
  rust: 'rust',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  diff: 'diff',
  patch: 'diff',
  // common aliases used as markdown fence info-strings
  typescript: 'typescript',
  javascript: 'javascript',
};

/**
 * Resolve an arbitrary lang hint (file extension WITHOUT the dot, or a markdown fence
 * info-string) to a Shiki language id we actually loaded. Unknown → `'text'`.
 */
export function resolveLang(hint: string | null | undefined): string {
  if (!hint) return 'text';
  const key = hint.replace(/^\./, '').trim().toLowerCase();
  if (!key) return 'text';
  const mapped = EXT_LANG[key];
  if (mapped) return mapped;
  // accept a hint that already names a loaded grammar (e.g. "css")
  if ((LANGS as string[]).includes(key)) return key;
  return 'text';
}

let highlighterPromise: Promise<Highlighter> | null = null;

/** Get (and lazily create) the shared highlighter. Cached as a module-level promise. */
export function getShikiHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighter } = await import('shiki');
      return createHighlighter({ themes: [SHIKI_THEME], langs: LANGS });
    })().catch((e) => {
      // allow a later retry rather than caching a permanently-rejected promise
      highlighterPromise = null;
      throw e;
    });
  }
  return highlighterPromise;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Highlight a whole code string to an HTML string for the given lang hint.
 * Falls back to an escaped `<pre><code>` plain-text block on unknown lang / load failure.
 * The returned HTML is Shiki-generated (token spans) or our own escaped text — never raw input.
 */
export async function highlightToHtml(code: string, langHint: string): Promise<string> {
  const lang = resolveLang(langHint);
  const fallback = `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`;
  if (lang === 'text') return fallback;
  try {
    const hl = await getShikiHighlighter();
    if (!hl.getLoadedLanguages().includes(lang)) return fallback;
    return hl.codeToHtml(code, { lang: lang as BundledLanguage, theme: SHIKI_THEME });
  } catch {
    return fallback;
  }
}

/**
 * Tokenize a SINGLE line of code into `{ content, color }` runs for the given lang hint.
 * Used by DiffView (per-line foreground coloring; backgrounds/signs stay in DiffView).
 * Returns a single uncolored run on unknown lang / failure — caller renders it as plain text.
 */
export interface ColorToken {
  content: string;
  color?: string;
}

export async function highlightLineTokens(line: string, langHint: string): Promise<ColorToken[]> {
  const lang = resolveLang(langHint);
  if (lang === 'text' || line === '') return [{ content: line }];
  try {
    const hl = await getShikiHighlighter();
    if (!hl.getLoadedLanguages().includes(lang)) return [{ content: line }];
    // `lang` is verified-loaded above; cast satisfies the BundledLanguage param type.
    const { tokens } = hl.codeToTokens(line, { lang: lang as BundledLanguage, theme: SHIKI_THEME });
    const flat: ColorToken[] = [];
    for (const row of tokens) {
      for (const t of row as ThemedToken[]) flat.push({ content: t.content, color: t.color });
    }
    return flat.length ? flat : [{ content: line }];
  } catch {
    return [{ content: line }];
  }
}
