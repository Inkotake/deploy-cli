#!/usr/bin/env node
/**
 * Import hygiene check — NOT part of the CLI.
 *
 * The package has no dependencies and no install step, so every import must be a `node:` builtin or
 * a relative module. This fails loudly if anything else appears, which is what keeps "runs from a
 * tarball with no node_modules" true as the code grows.
 *
 * The scan looks at *statements*, not at raw text: template literals and block comments are removed
 * first, because prose and diagnostics mention file names ("...published from \"gh-pages\"") and a
 * naive `from '...'` pattern would report those as dependencies.
 *
 * Usage: node tools/check-imports.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const offenders = [];

const PATTERNS = [
  /(?:^|\n)[ \t]*(?:import|export)\s[^\n]*?from\s*['"]([^'"]+)['"]/g, // import x from '...'
  /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g, // import '...';
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g // await import('...')
];

function specifiersOf(text) {
  const code = text
    .replace(/`(?:\\.|[^`\\])*`/gs, '``')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [];
  for (const pattern of PATTERNS) {
    for (const match of code.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
      walk(full);
      continue;
    }
    if (!/\.(mjs|js)$/.test(entry.name)) continue;
    for (const specifier of specifiersOf(fs.readFileSync(full, 'utf8'))) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      offenders.push(`${path.relative(root, full)} -> ${specifier}`);
    }
  }
})(root);

if (offenders.length) {
  process.stdout.write('non-builtin imports found:\n' + offenders.join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('ok: every import is a node: builtin or a relative module\n');
