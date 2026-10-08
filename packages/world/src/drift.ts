import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;

async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", [...args], { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return undefined;
  }
}

export interface SourceCommit {
  sha: string;
  /** Whether this checkout has the commit object, so it can be described and compared. */
  known: boolean;
  subject?: string;
  /** This checkout's HEAD and branch: the world driver and recipes always run from here. */
  head?: string;
  branch?: string;
  /** Files under the recipe paths that differ between this working tree and the commit. */
  recipeDrift?: string[];
}

/**
 * The commit a remote world builds, and whether this checkout's world recipes
 * differ from it. Remote worlds build a pushed commit, but the driver that
 * provisions them runs from the local checkout; an old checkout quietly boots
 * old recipes against new source.
 */
export async function describeSourceCommit(cwd: string, sha: string, recipePaths: readonly string[] = []): Promise<SourceCommit> {
  if (!SHA.test(sha)) throw new Error("A full 40-character commit SHA is required.");
  const known = (await git(cwd, ["cat-file", "-e", `${sha}^{commit}`])) !== undefined;
  const [subject, head, branch, diff] = await Promise.all([
    known ? git(cwd, ["log", "-1", "--format=%s", sha]) : undefined,
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    known && recipePaths.length > 0 ? git(cwd, ["diff", "--name-only", sha, "--", ...recipePaths]) : undefined,
  ]);
  return {
    sha,
    known,
    ...(subject?.trim() ? { subject: subject.trim() } : {}),
    ...(head?.trim() ? { head: head.trim() } : {}),
    ...(branch?.trim() && branch.trim() !== "HEAD" ? { branch: branch.trim() } : {}),
    ...(diff === undefined ? {} : { recipeDrift: diff.split(/\r?\n/).filter(Boolean) }),
  };
}

/**
 * Header lines: which commit this is (so "which build is that?" is answered up
 * front), and a note when this checkout's recipes are not that commit's.
 */
export function sourceCommitLines(commit: SourceCommit, options: { label?: string; component?: string } = {}): string[] {
  const short = commit.sha.slice(0, 9);
  const lines = [`source  ${options.component ? `${options.component} ` : ""}${short}${options.label ? ` (${options.label})` : ""}${commit.subject ? ` ${commit.subject}` : ""}`];
  const driver = commit.head ? `${commit.head.slice(0, 9)}${commit.branch ? ` on ${commit.branch}` : ""}` : "this checkout";
  const worktree = `git worktree add ../openwork-${short} ${options.label === "origin/dev" ? "origin/dev" : short}`;
  const drift = commit.recipeDrift?.length ?? 0;
  if (drift > 0) {
    lines.push(`note  this checkout's world recipes differ from ${short} in ${drift} file${drift === 1 ? "" : "s"}; the driver runs from this checkout (${driver}), not from ${short}. For that commit's recipes, run from a worktree: ${worktree}`);
  } else if (!commit.known && commit.head !== commit.sha) {
    lines.push(`note  ${short} is not in this checkout, so its world recipes cannot be compared; the driver runs from ${driver}. Run git fetch origin to compare.`);
  }
  return lines;
}
