import { appendFile, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function runJudge(path) {
  return new Promise(resolve => {
    const child = spawn('pnpm', ['--dir', 'evals', 'evidence:judge', '--', '--test-run', path], { stdio: 'inherit' });
    child.once('error', () => resolve(null));
    child.once('close', status => resolve(status));
  });
}

export async function judgeJourneys(directory, expectedSha, run = runJudge) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let count = 0;
  let failed = false;
  let incomplete = false;
  // Two records, each with at most two screenshot judges, cap this invocation
  // at four provider requests. Keep provenance/path checks ahead of each run.
  const pending = entries.values();
  await Promise.all(Array.from({ length: 2 }, async () => {
    for (const entry of pending) {
      if (!entry.isDirectory()) continue;
      const path = resolve(directory, entry.name);
      const record = JSON.parse(await readFile(join(path, 'test-run.json'), 'utf8').catch(() => 'null'));
      if (!record || !expectedSha || record.gitSha !== expectedSha) {
        incomplete = true;
        continue;
      }
      const root = await realpath(path);
      const artifacts = await Promise.all((record.artifacts ?? []).map(async artifact => {
        if (!artifact.fileName) return true;
        const target = await realpath(resolve(root, artifact.fileName)).catch(() => '');
        return target.startsWith(`${root}${sep}`);
      }));
      if (artifacts.includes(false)) {
        incomplete = true;
        continue;
      }
      count++;
      const status = await run(path);
      if (status === 1) failed = true;
      else if (status !== 0) incomplete = true;
    }
  }));
  return { count, result: failed ? 'failure' : incomplete || count === 0 ? 'incomplete' : 'success' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { count, result } = await judgeJourneys('evals/results/test-runs', process.env.EXPECTED_SHA);
  await appendFile(process.env.GITHUB_OUTPUT, `result=${result}\n`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nEvidence: ${count} journey record(s) checked — **${result}**.\n`);
  process.exitCode = result === 'success' ? 0 : result === 'failure' ? 1 : 2;
}
