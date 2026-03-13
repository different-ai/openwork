import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = new URL('./check-no-local-pr-artifacts.sh', import.meta.url);

async function initRepo() {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'openwork-pr-artifacts-guard-'));
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'codex@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Codex'], { cwd: repoDir });
  await writeFile(path.join(repoDir, 'README.md'), '# temp repo\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir });
  return repoDir;
}

test('guardrail fails when artifacts/ is introduced in the diff', async () => {
  const repoDir = await initRepo();
  await mkdir(path.join(repoDir, 'artifacts'), { recursive: true });
  await writeFile(path.join(repoDir, 'artifacts', 'proof.png'), 'fake');

  await assert.rejects(
    () => execFileAsync('bash', [scriptPath.pathname], { cwd: repoDir }),
    (error) => {
      assert.match(error.stderr, /artifacts\/proof\.png/);
      return true;
    },
  );
});

test('guardrail allows temporary files outside forbidden proof paths', async () => {
  const repoDir = await initRepo();
  await mkdir(path.join(repoDir, 'tmp', 'other'), { recursive: true });
  await writeFile(path.join(repoDir, 'tmp', 'other', 'proof.png'), 'fake');

  await execFileAsync('bash', [scriptPath.pathname], { cwd: repoDir });
});
