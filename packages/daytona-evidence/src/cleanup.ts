import { digest } from "@openwork/freestyle/cache";
import { DaytonaApi, type Sandbox } from "./api.ts";
import { DAYTONA_BASE_PREFIX, DAYTONA_BASE_SNAPSHOT, DAYTONA_IMAGE_PREFIX, DAYTONA_TEMPLATE_PREFIX } from "./builder.ts";
import { CAPTURE_KIND, CHECKPOINT_PREFIX, COPY_KIND } from "./checkpoints.ts";
import { EVIDENCE_KIND } from "./world.ts";
import { PREVIEW_KIND } from "./kinds.ts";
import { PREVIEW_SNAPSHOT_PREFIX, PREVIEW_TOOLS_PREFIX } from "./previews.ts";

const WORLD_MAX_IDLE_MS = 2 * 3600_000;
const IMAGE_MAX_AGE_MS = 7 * 24 * 3600_000;
const SANDBOX_MAX_AGE_MS = 2 * 3600_000;
const CHECKPOINT_MAX_AGE_MS = 14 * 3600_000;
const CHECKPOINT_MAX_COUNT = 30;
const BUILDER_KIND = "openwork-daytona-builder-v1";
const OWNED_KINDS = new Set([EVIDENCE_KIND, BUILDER_KIND, CAPTURE_KIND, COPY_KIND, PREVIEW_KIND]);
const TERMINAL_STATES = new Set(["stopped", "archived", "error", "build_failed"]);

export interface CleanupResult { deletedSnapshots: string[]; deletedSandboxes: string[] }
interface CleanupOptions { dryRun?: boolean; now?: number; protectedSnapshots?: readonly string[] }

/**
 * Reclaim only evidence resources. Age is not proof a controller has finished:
 * live builders/forks/worlds/copies are never deleted. Pending snapshots are
 * never candidates. Full account inventory (not just owned sandboxes) protects
 * snapshot references held by dev/release resources as well.
 */
export async function cleanupDaytonaEvidence(api = new DaytonaApi(), { dryRun = false, now = Date.now(), protectedSnapshots = [] }: CleanupOptions = {}): Promise<CleanupResult> {
  const result: CleanupResult = { deletedSnapshots: [], deletedSandboxes: [] };
  const age = (at?: string) => at ? now - Date.parse(at) : NaN;
  const snapshots = await api.listSnapshots();
  const sandboxes = await api.listSandboxes();
  const newestFirst = (a: { createdAt?: string }, b: { createdAt?: string }) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "");
  const images = snapshots.filter((s) => s.name.startsWith(DAYTONA_IMAGE_PREFIX)).sort(newestFirst);
  const checkpoints = snapshots.filter((s) => s.name.startsWith(CHECKPOINT_PREFIX)).sort(newestFirst);
  const worlds = snapshots.filter((s) => s.name.startsWith(DAYTONA_TEMPLATE_PREFIX)).sort(newestFirst);
  const protectedNames = new Set([...protectedSnapshots, DAYTONA_BASE_SNAPSHOT, `${DAYTONA_BASE_SNAPSHOT}-plain`, images[0]?.name, worlds[0]?.name,
    images.find((s) => s.state === "active")?.name, worlds.find((s) => s.state === "active")?.name]);
  const inUse = (inventory: Sandbox[], id: string, name: string) => inventory.some((s) =>
    s.snapshot === id || s.snapshot === name || s.labels.checkpoint === name
    // Protect the target as well as the parent. Known targets let cleanup free
    // unrelated expired evidence while a quota-rejected builder waits. Unknown
    // targets fail closed, including the interval before a fork is labelled.
    || (s.labels.kind === BUILDER_KIND && (!s.labels.layer || s.labels.layer === digest(name).slice(0, 24)))
    || (s.labels.kind === CAPTURE_KIND && (!s.labels.checkpoint || s.labels.checkpoint === name)));
  const expired = (s: typeof snapshots[number]) =>
    (s.name.startsWith(DAYTONA_TEMPLATE_PREFIX) && age(s.lastUsedAt ?? s.createdAt) > WORLD_MAX_IDLE_MS)
    || (s.name.startsWith(CHECKPOINT_PREFIX) && (checkpoints.indexOf(s) >= CHECKPOINT_MAX_COUNT || age(s.createdAt) > CHECKPOINT_MAX_AGE_MS))
    || (s.name.startsWith(DAYTONA_IMAGE_PREFIX) && age(s.createdAt) > IMAGE_MAX_AGE_MS)
    || (s.name.startsWith(PREVIEW_SNAPSHOT_PREFIX) && age(s.lastUsedAt ?? s.createdAt) > 2 * 24 * 3600_000)
    || (s.name.startsWith(PREVIEW_TOOLS_PREFIX) && age(s.lastUsedAt ?? s.createdAt) > IMAGE_MAX_AGE_MS)
    || s.name.startsWith(DAYTONA_BASE_PREFIX);
  for (const snapshot of snapshots) {
    if (snapshot.state !== "active" || !Number.isFinite(age(snapshot.createdAt))
      || protectedNames.has(snapshot.name) || !expired(snapshot) || inUse(sandboxes, snapshot.id, snapshot.name)) continue;
    if (!dryRun) {
      // Re-read before mutation: a scheduled job's inventory can age while it runs.
      const current = await api.getSnapshot(snapshot.name);
      if (!current || current.id !== snapshot.id || current.state !== "active"
        || current.lastUsedAt !== snapshot.lastUsedAt || inUse(await api.listSandboxes(), snapshot.id, snapshot.name)) continue;
      await api.deleteSnapshot(snapshot.id);
    }
    result.deletedSnapshots.push(snapshot.name);
  }
  for (const sandbox of sandboxes) {
    // Access and a guest shutdown timer enforce the exact two-hour deadline.
    // This independent controller also reclaims a still-active expired preview,
    // including one whose guest shutdown was prevented or whose launcher died.
    if (sandbox.labels.kind === PREVIEW_KIND && Date.parse(sandbox.labels.expiresAt ?? "") <= now) {
      if (!dryRun) {
        const current = await api.getSandbox(sandbox.id);
        if (!current || current.labels.kind !== PREVIEW_KIND || current.labels.expiresAt !== sandbox.labels.expiresAt
          || !(Date.parse(current.labels.expiresAt ?? "") <= now)) continue;
        await api.deleteSandbox(sandbox.id);
      }
      result.deletedSandboxes.push(sandbox.name);
      continue;
    }
    // Cold saves stop their builder before snapshotting. A stopped builder is
    // not proof of abandonment; only its controller/provider TTL may remove it.
    if ([BUILDER_KIND, CAPTURE_KIND].includes(sandbox.labels.kind)) continue;
    if (!OWNED_KINDS.has(sandbox.labels.kind) || !TERMINAL_STATES.has(sandbox.state)
      || !(age(sandbox.lastActivityAt ?? sandbox.createdAt) > SANDBOX_MAX_AGE_MS)) continue;
    if (!dryRun) {
      const current = await api.getSandbox(sandbox.id);
      if (!current || current.labels.kind !== sandbox.labels.kind || !TERMINAL_STATES.has(current.state)
        || !(age(current.lastActivityAt ?? current.createdAt) > SANDBOX_MAX_AGE_MS)) continue;
      await api.deleteSandbox(sandbox.id);
    }
    result.deletedSandboxes.push(sandbox.name);
  }
  return result;
}
