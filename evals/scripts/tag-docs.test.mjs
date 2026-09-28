import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { END, START, docPath, readTags, staleMessage, tagTable, withTable } from './tag-docs.mjs';

test('the tag table in docs/testing.md matches the tags declared in evals/vitest.config.ts', () => {
  const doc = readFileSync(docPath, 'utf8');
  const tags = readTags();
  assert(tags.some(tag => tag.name === 'user-flow') && tags.some(tag => tag.name === 'critical'));
  assert.equal(withTable(doc, tagTable(tags)), doc, staleMessage());
});

test('the table escapes pipes, keeps declaration order, and needs both markers', () => {
  const table = tagTable([{ name: 'b', description: 'x | y' }, { name: 'a', description: 'z' }]);
  assert.match(table, /\| `b` \| x \\\| y \|\n\| `a` \| z \|$/);
  assert.equal(withTable(`intro\n${START}\nold\n${END}\nrest`, 'new'), `intro\n${START}\nnew\n${END}\nrest`);
  assert.throws(() => withTable('no markers', 'new'), /tags:start/);
  assert.match(staleMessage(), /pnpm --dir evals docs:tags/);
});
