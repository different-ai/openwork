import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function judgeJourneys(directory, expectedSha, run = path => spawnSync('pnpm', ['--dir', 'evals', 'evidence:judge', '--', '--test-run', path], { stdio: 'inherit' }).status) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let count = 0;
  let failed = false;
  let incomplete = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = resolve(directory, entry.name);
    const record = JSON.parse(await readFile(join(path, 'test-run.json'), 'utf8').catch(() => 'null'));
    if (!record || !expectedSha || record.gitSha !== expectedSha) {
      incomplete = true;
      continue;
    }
    count++;
    const status = await run(path);
    if (status === 1) failed = true;
    else if (status !== 0) incomplete = true;
  }
  return { count, result: failed ? 'failure' : incomplete || count === 0 ? 'incomplete' : 'success' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { count, result } = await judgeJourneys('evals/results/test-runs', process.env.EXPECTED_SHA);
  await appendFile(process.env.GITHUB_OUTPUT, `result=${result}\n`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nEvidence: ${count} journey record(s) checked — **${result}**.\n`);
  process.exitCode = result === 'success' ? 0 : result === 'failure' ? 1 : 2;
}
