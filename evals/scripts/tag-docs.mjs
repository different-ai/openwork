#!/usr/bin/env node
// Writes the tag table in docs/testing.md from the tags declared in evals/vitest.config.ts, so the
// descriptions there stay the one source of truth. `--check` fails instead of writing.
//   pnpm --dir evals docs:tags            regenerate
//   pnpm --dir evals docs:tags --check    fail when the table is stale
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalsDir = fileURLToPath(new URL('..', import.meta.url));
export const docPath = fileURLToPath(new URL('../../docs/testing.md', import.meta.url));
export const START = '<!-- tags:start -->';
export const END = '<!-- tags:end -->';
export const REGENERATE = 'pnpm --dir evals docs:tags';

// Vitest's own view of the declared tags (`vitest --list-tags=json`), in declaration order.
export function readTags() {
  const require = createRequire(join(evalsDir, 'package.json'));
  const manifest = require.resolve('vitest/package.json');
  const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin.vitest;
  const output = execFileSync(process.execPath, [join(dirname(manifest), bin), '--list-tags=json'], { cwd: evalsDir, encoding: 'utf8' });
  const tags = JSON.parse(output).tags;
  if (!Array.isArray(tags) || tags.length === 0) throw new Error('vitest --list-tags=json returned no tags');
  return tags.map(({ name, description }) => ({ name: String(name), description: String(description ?? '') }));
}

export function tagTable(tags) {
  const cell = text => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    `<!-- Generated from evals/vitest.config.ts by \`${REGENERATE}\`; edit the descriptions there. -->`,
    '',
    '| Tag | Meaning |',
    '| --- | --- |',
    ...tags.map(tag => `| \`${tag.name}\` | ${cell(tag.description)} |`),
  ].join('\n');
}

export function withTable(doc, table) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < start) throw new Error(`docs/testing.md needs ${START} and ${END} markers around the tag table`);
  return `${doc.slice(0, start + START.length)}\n${table}\n${doc.slice(end)}`;
}

export function staleMessage() {
  return `docs/testing.md tag table is out of date with evals/vitest.config.ts; run \`${REGENERATE}\` and commit the result.`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const doc = readFileSync(docPath, 'utf8');
  const next = withTable(doc, tagTable(readTags()));
  if (process.argv.includes('--check')) {
    if (next !== doc) {
      console.error(staleMessage());
      process.exit(1);
    }
    console.log('docs/testing.md tag table is up to date.');
  } else if (next !== doc) {
    writeFileSync(docPath, next);
    console.log('Updated the tag table in docs/testing.md.');
  } else {
    console.log('docs/testing.md tag table is already up to date.');
  }
}
