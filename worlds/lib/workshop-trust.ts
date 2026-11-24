import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export interface VerifiedSnapshot { id: string; image: string; sourceSandboxId: string; appRef: string; audit: string }

/** Reviewed snapshot provenance lives in the repository; changing it needs a PR. */
export async function readSnapshotManifest(repoRoot: string): Promise<Record<string, VerifiedSnapshot>> {
  const parsed: unknown = JSON.parse(await readFile(join(repoRoot, "scripts/workshop/snapshots.json"), "utf8"));
  if (!record(parsed)) throw new Error("scripts/workshop/snapshots.json must be an object.");
  const entries: Record<string, VerifiedSnapshot> = {};
  for (const [name, entry] of Object.entries(parsed)) {
    if (!record(entry) || ["id", "image", "sourceSandboxId", "appRef", "audit"].some((field) => typeof entry[field] !== "string" || !entry[field])) {
      throw new Error(`Snapshot manifest entry ${name} is incomplete.`);
    }
    entries[name] = { id: String(entry.id), image: String(entry.image), sourceSandboxId: String(entry.sourceSandboxId), appRef: String(entry.appRef), audit: String(entry.audit) };
  }
  return entries;
}

/** Pure comparison of what Daytona reports against the reviewed entry. */
export function snapshotProvenanceMismatch(name: string, appRef: string, expected: VerifiedSnapshot | undefined, actual: unknown): string | null {
  if (!expected) return `Snapshot ${name} has no reviewed entry in scripts/workshop/snapshots.json; attendee desktops only start from audited clean snapshots.`;
  if (expected.appRef !== appRef) return `Snapshot ${name} was built from ${expected.appRef.slice(0, 12)}, not the requested app commit ${appRef.slice(0, 12)}.`;
  if (!record(actual)) return `Daytona returned no snapshot named ${name}.`;
  if (actual.state !== "active") return `Snapshot ${name} is not active.`;
  for (const [field, want] of [["id", expected.id], ["ref", expected.image], ["sourceSandboxId", expected.sourceSandboxId]] as const) {
    if (actual[field] !== want) return `Snapshot ${name} does not match its reviewed provenance (${field} differs); it may have been replaced. Refusing to start attendee desktops from it.`;
  }
  return null;
}

/** Only an audited, reviewed clean snapshot may become an attendee desktop. */
export async function assertVerifiedWorkshopSnapshot(name: string, appRef: string, repoRoot: string, request: typeof fetch = fetch): Promise<void> {
  const key = process.env.DAYTONA_API_KEY?.trim();
  if (!key) throw new Error("DAYTONA_API_KEY is required to verify the workshop snapshot.");
  const manifest = await readSnapshotManifest(repoRoot);
  const org = process.env.WORKSHOP_DAYTONA_ORG?.trim() || "802dbb61-97d4-445a-9c80-e9255852a4e0";
  const response = await request(`https://app.daytona.io/api/snapshots/${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${key}`, "X-Daytona-Organization-ID": org }, signal: AbortSignal.timeout(30_000) });
  const actual: unknown = response.ok ? await response.json() : null;
  const mismatch = snapshotProvenanceMismatch(name, appRef, manifest[name], actual);
  if (mismatch) throw new Error(mismatch);
}

/**
 * Workshop desktops sign real attendee accounts in and hold their Den access
 * and model allowance. Only code that has already been reviewed and merged may
 * receive that: an arbitrary PR commit could capture the sign-in grant. There
 * is deliberately no override; test unmerged code with the normal preview worlds.
 */
export async function assertTrustedWorkshopRef(ref: string, repoRoot: string, trustedBranch = "dev"): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error("Workshop source must be a full commit SHA.");
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(trustedBranch) || trustedBranch.startsWith("-")) throw new Error("Invalid trusted branch name.");
  try {
    await run("git", ["fetch", "--quiet", "origin", trustedBranch], { cwd: repoRoot, timeout: 120_000 });
  } catch {
    throw new Error(`Could not refresh origin/${trustedBranch}; refusing to sign attendees into unverified source.`);
  }
  try {
    await run("git", ["merge-base", "--is-ancestor", ref, `origin/${trustedBranch}`], { cwd: repoRoot, timeout: 60_000 });
  } catch {
    throw new Error(`Workshop source ${ref.slice(0, 12)} is not merged into origin/${trustedBranch}. Attendees are only signed in to reviewed, merged code; use a commit from ${trustedBranch}.`);
  }
}
