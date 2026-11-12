import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Only registry transport failures are retryable. Never retry lifecycle scripts,
// invalid lockfiles, permissions, authentication, or integrity failures.
export function transientInstallFailure(output) {
  if (/ERR_PNPM_(?:OUTDATED_LOCKFILE|FROZEN_LOCKFILE|LOCKFILE|TARBALL_INTEGRITY|FETCH_40[134])|ELIFECYCLE|EACCES|EPERM|integrity check failed|certificate|self.signed|unable to verify/i.test(output)) return false;
  return /(?:registry|\.tgz|ERR_PNPM_(?:META_FETCH_FAIL|FETCH_5\d\d))/.test(output)
    && /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|aborted due to timeout|HTTP\s*5\d\d|ERR_PNPM_FETCH_5\d\d|error \((?:23|50[0234])\)/i.test(output);
}

export async function installWithRetry(args, { run, wait = setTimeout, warn = console.warn }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await run(args);
    if (result.status === 0) return 0;
    if (attempt === 2 || !transientInstallFailure(result.output)) return result.status ?? 1;
    warn('Registry transport failed; retrying the frozen pnpm install once in 10 seconds.');
    await wait(10_000);
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(windows ? 'pnpm.cmd' : 'pnpm', args, {
      shell: windows, stdio: ['inherit', 'pipe', 'pipe'],
    });
    let output = '';
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on('data', chunk => {
        destination.write(chunk);
        output = (output + chunk.toString()).slice(-256_000);
      });
    }
    child.once('error', reject);
    child.once('close', status => resolve({ status, output }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (!args.includes('install') || !args.includes('--frozen-lockfile')) throw new Error('Only frozen pnpm installs are supported');
  process.exitCode = await installWithRetry(args, { run });
}
