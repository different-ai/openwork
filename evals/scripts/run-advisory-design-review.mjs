import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ADVISORY_TIMEOUT_MS = 120_000;

/**
 * A hard wall-clock budget, independent of provider timeouts or worker cooperation.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions & { timeoutMs?: number }} options
 */
export function runAdvisory(command, args, { timeoutMs = ADVISORY_TIMEOUT_MS, ...spawnOptions } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...spawnOptions, detached: true, stdio: 'inherit' });
    let settled = false;
    function killGroup() {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Also stop descendants left behind by an already-exited worker.
      killGroup();
      process.off('SIGTERM', cancel);
      process.off('SIGINT', cancel);
      resolve(result);
    }
    function cancel() {
      killGroup();
      process.exit(130);
    }
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    process.once('SIGTERM', cancel);
    process.once('SIGINT', cancel);
    child.once('error', error => finish({ status: 'error', error: error.message }));
    // Do not wait for `close`: an inherited descriptor in a descendant can keep it open.
    child.once('exit', (code, signal) => finish({ status: code === 0 ? 'complete' : 'error', code, signal }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runAdvisory(process.execPath, ['evals/scripts/design-review-journeys.mjs']);
  if (result.status !== 'complete') {
    const message = result.status === 'timeout'
      ? 'Advisory design review reached its 120-second cap; completed notes are retained. Remaining screenshots were not reviewed.'
      : 'Advisory design review could not finish; completed notes are retained.';
    process.stdout.write(`::warning::${message}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${message} Screenshot assertions and the proof verdict are unchanged.\n`);
    }
  }
  // Advisory failure/timeout is not a failed proof. Mandatory judgments run separately.
}
