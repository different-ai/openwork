import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A throwaway repository with one commit that has a world recipe in it. */
export async function fixtureRepo(): Promise<{ root: string; sha: string; git: (...args: string[]) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-drift-"));
  const git = async (...args: string[]): Promise<string> => (await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root })).stdout.trim();
  await git("init", "--quiet", "--initial-branch=main");
  await mkdir(join(root, "worlds"));
  await writeFile(join(root, "worlds", "remote.ts"), 'export const supportedTargets = ["local/host", "daytona/linux"];\n');
  await writeFile(join(root, "README.md"), "fixture\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "feat: fixture world recipe");
  return { root, sha: await git("rev-parse", "HEAD"), git };
}
