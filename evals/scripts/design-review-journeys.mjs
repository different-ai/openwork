import { appendFile, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Advisory design review for every proof record of the PR head: measured
 * layout rules, plus the rubric critique when a model key is present. Writes
 * design-review.json beside each test-run.json; never fails the job for a
 * finding, only for a crash.
 */
export async function reviewJourneys(directory, expectedSha, review) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const summaries = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = resolve(directory, entry.name);
    const record = JSON.parse(await readFile(join(path, 'test-run.json'), 'utf8').catch(() => 'null'));
    if (!record || !expectedSha || record.gitSha !== expectedSha) continue;
    const root = await realpath(path);
    const inside = await Promise.all((record.artifacts ?? []).map(async artifact => {
      if (!artifact.fileName) return true;
      const target = await realpath(resolve(root, artifact.fileName)).catch(() => '');
      return target.startsWith(`${root}${sep}`);
    }));
    if (inside.includes(false)) continue;
    summaries.push(await review(path, record.name ?? entry.name));
  }
  return summaries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { renderDesignReview, reviewDesign } = await import('../packages/test-evidence/src/design-review.ts');
  const summaries = await reviewJourneys('evals/results/test-runs', process.env.EXPECTED_SHA, async (path, name) =>
    renderDesignReview(name, await reviewDesign(path)));
  const body = summaries.length
    ? `\n## Design review (advisory)\n\n${summaries.join('\n')}`
    : '\nDesign review: no screenshots from this commit to review.\n';
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, body);
  process.stdout.write(body);
}
