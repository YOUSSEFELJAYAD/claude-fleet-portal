#!/usr/bin/env node
// Discover every function/method in the codebase via the TypeScript AST and
// emit a catalog (function.json). Cross-references each exported symbol against
// the test suite to mark whether a real test imports it.
//
// Usage: node tools/discover-functions.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
// TypeScript is installed inside the server workspace.
const requireFromServer = createRequire(join(ROOT, 'apps/server/package.json'));
const ts = requireFromServer('typescript');

// Source roots to catalog.
const SRC_GLOBS = [
  'apps/server/src',
  'packages/shared/src',
  'apps/web/lib',
];
const TEST_GLOBS = ['apps/server/test', 'apps/web/test'];

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) acc.push(p);
  }
  return acc;
}

function paramText(node, sf) {
  return (node.parameters || []).map((p) => p.getText(sf)).join(', ');
}

function returnText(node, sf) {
  return node.type ? node.type.getText(sf) : '';
}

// Collect functions from one source file.
function collectFromFile(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, /tsx?$/.test(absPath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = relative(ROOT, absPath);
  const out = [];

  function isExported(node) {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return !!mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }

  function lineOf(node) {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  }

  function record(name, kind, node, exported, sig) {
    out.push({ name, kind, file: rel, line: lineOf(node), exported, signature: sig });
  }

  function visit(node, classCtx) {
    // export function foo(...) / function foo(...)
    if (ts.isFunctionDeclaration(node) && node.name) {
      const sig = `function ${node.name.text}(${paramText(node, sf)})${returnText(node, sf) ? ': ' + returnText(node, sf) : ''}`;
      record(node.name.text, 'function', node, isExported(node), sig);
    }
    // const foo = (...) => ...  /  const foo = function(...) {}
    else if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) && ts.isIdentifier(decl.name)) {
          const init = decl.initializer;
          const sig = `const ${decl.name.text} = (${paramText(init, sf)})${returnText(init, sf) ? ': ' + returnText(init, sf) : ''} =>`;
          record(decl.name.text, 'arrow', decl, exported, sig);
        }
      }
    }
    // class declarations + their methods
    else if (ts.isClassDeclaration(node) && node.name) {
      const exported = isExported(node);
      record(node.name.text, 'class', node, exported, `class ${node.name.text}`);
      for (const m of node.members) {
        if ((ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) && (m.name || ts.isConstructorDeclaration(m))) {
          const mname = ts.isConstructorDeclaration(m) ? 'constructor' : m.name.getText(sf);
          const sig = `${node.name.text}.${mname}(${paramText(m, sf)})`;
          record(`${node.name.text}.${mname}`, 'method', m, exported, sig);
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, classCtx));
  }
  visit(sf, null);
  return out;
}

// Parse test files: which symbols do they import from the source modules?
function collectTestedSymbols(testFiles) {
  const tested = new Map(); // symbolName -> Set(testFile)
  for (const absPath of testFiles) {
    const text = readFileSync(absPath, 'utf8');
    const rel = relative(ROOT, absPath);
    const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const spec = node.moduleSpecifier.getText(sf);
        // only count imports that point back into our source (relative ../src or @fleet/*)
        const fromSrc = /\.\.\/src|@fleet\//.test(spec);
        const nb = node.importClause.namedBindings;
        if (fromSrc && nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const n = el.name.text;
            if (!tested.has(n)) tested.set(n, new Set());
            tested.get(n).add(rel);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return tested;
}

// Also: which symbols are *referenced by name* anywhere in any test file?
// This codebase tests via dynamic import + namespace access (e.g.
// `release.compareVersions(...)`), so a name reference is the real "tested"
// signal — static named imports miss almost everything.
function collectReferencedNames(testFiles) {
  const blob = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  return { has: (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(blob), blob };
}

const srcFiles = SRC_GLOBS.flatMap((g) => walk(join(ROOT, g)));
const testFiles = TEST_GLOBS.flatMap((g) => walk(join(ROOT, g)));

const allFns = srcFiles.flatMap(collectFromFile);
const importedSymbols = collectTestedSymbols(testFiles);
const referenced = collectReferencedNames(testFiles);

// Route-integration coverage: a register*Routes function is exercised when its module's
// own /api/* route prefixes are hit by a test (via buildServer().inject()), even though
// the registrar's NAME never appears in a test. Map each source file → the set of
// /api/<segment> prefixes it declares, then check the test blob for any of them.
function routePrefixesFor(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const prefixes = new Set();
  for (const m of text.matchAll(/['"`](\/api\/[A-Za-z0-9_-]+)/g)) prefixes.add(m[1]);
  return [...prefixes];
}
const fileRoutePrefixes = new Map(srcFiles.map((f) => [relative(ROOT, f), routePrefixesFor(f)]));
function moduleHasRouteCoverage(relFile) {
  const prefixes = fileRoutePrefixes.get(relFile) || [];
  return prefixes.some((p) => referenced.blob.includes(p));
}

// Honest annotations for functions the name/route heuristics can't see, OR that genuinely
// require a harness this repo doesn't have (React render, full E2E). Keyed by function name.
const COVERAGE_OVERRIDES = {
  // exercised for real, just not by direct name reference in a test:
  getShikiHighlighter: { coverage: 'transitive', note: 'called internally by highlightToHtml/highlightLineTokens, which ARE tested (fn-shiki-render.test.ts)' },
  spawnClaude: { coverage: 'integration', note: 'exercised by every launch-based test via the mock-claude binary (retry/failure/thinking/model-routing.test.ts → registry.launch → spawnClaude)' },
  // NOTE: the React hooks (useFleet/useRunStream/useCampaign/useAsync) are now unit-tested under a
  // jsdom + @testing-library/react harness in apps/web/test; startResolveMerge/startTriggerPoller/
  // watchTeam are now unit-tested in apps/server/test — so they are no longer overridden here.
};

const catalog = allFns.map((fn) => {
  const baseName = fn.name.includes('.') ? fn.name.split('.')[0] : fn.name;
  const directlyImported = importedSymbols.has(fn.name) || importedSymbols.has(baseName);
  const importedBy = directlyImported
    ? [...(importedSymbols.get(fn.name) || importedSymbols.get(baseName) || new Set())]
    : [];
  const methodName = fn.name.includes('.') ? fn.name.split('.').pop() : null;
  // A bare method name like "constructor"/"close" is too generic to count as
  // a real reference; require the qualified or non-trivial form.
  const referencedByName = referenced.has(fn.name) ||
    (methodName && methodName.length > 4 && methodName !== 'constructor' && referenced.has(methodName));
  // A route registrar (registerXRoutes) counts as covered when its module's endpoints
  // are exercised over HTTP by a test, even if the function name is never referenced.
  const isRouteRegistrar = /^register[A-Z].*Routes$/.test(fn.name);
  const integrationCovered = isRouteRegistrar && moduleHasRouteCoverage(fn.file);
  let coverage = (directlyImported || referencedByName) ? 'unit'
    : integrationCovered ? 'integration'
    : 'none';
  let note;
  const override = COVERAGE_OVERRIDES[fn.name];
  // only apply an override to the genuinely-unseen ones (don't downgrade a real unit test)
  if (override && coverage === 'none') { coverage = override.coverage; note = override.note; }
  const tested = coverage !== 'none';
  return {
    ...fn,
    tested,
    coverage,
    ...(note ? { note } : {}),
    testedHint: directlyImported ? 'imported' : (referencedByName ? 'referenced-by-name' : (integrationCovered ? 'route-integration' : coverage)),
    importedBy,
  };
});

// Sort A→Z by name, then file.
catalog.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));

const summary = {
  generatedFrom: 'tools/discover-functions.mjs',
  totals: {
    functions: catalog.length,
    exported: catalog.filter((f) => f.exported).length,
    exportedTested: catalog.filter((f) => f.exported && f.tested).length,
    exportedUnit: catalog.filter((f) => f.exported && f.coverage === 'unit').length,
    exportedIntegration: catalog.filter((f) => f.exported && f.coverage === 'integration').length,
    exportedTransitive: catalog.filter((f) => f.exported && f.coverage === 'transitive').length,
    exportedUntested: catalog.filter((f) => f.exported && !f.tested).length,
    internalUntested: catalog.filter((f) => !f.exported && !f.tested).length,
  },
  sourceFiles: srcFiles.length,
  testFiles: testFiles.length,
};

writeFileSync(join(ROOT, 'function.json'), JSON.stringify({ summary, functions: catalog }, null, 2));
console.log(JSON.stringify(summary, null, 2));

// Print the exported-but-untested list for triage.
const untested = catalog.filter((f) => f.exported && !f.tested);
console.log(`\n=== EXPORTED + UNTESTED (${untested.length}) ===`);
for (const f of untested) console.log(`  [${f.testedHint.padEnd(18)}] ${f.name}  (${f.file}:${f.line})`);
