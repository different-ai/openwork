import { setTimeout as delay } from "node:timers/promises";
import { FreestyleApiError, type Freestyle } from "freestyle";
import { snapshotSlug, type PreviewWorld } from "./index.ts";
import { EVIDENCE_TEMPLATE_PREFIX } from "./evidence-builder.ts";

/**
 * Snapshot storage is billed until deletion, and every CI-built layer is ours to
 * reclaim. Only names this package creates are considered; anything else on the
 * team (personal worlds, manual experiments) is never touched.
 */
export interface CleanupSnapshot { id: string; slug?: string | null; createdAt: string; lastUsedAt?: string | null }
export interface CleanupItem { id: string; slug: string; reason: string }
export interface CleanupOptions { now: number; inUse: ReadonlySet<string> }

const HOUR = 3600_000;
/** Anything touched this recently may belong to a build or launch in flight. */
const RECENT = 2 * HOUR;
/** A preview snapshot nobody has launched for a day is rebuilt on demand if needed. */
const PREVIEW_IDLE = 24 * HOUR;
/** Superseded cache layers are kept this long in case an older commit rebuilds. */
const LAYER_IDLE = 24 * HOUR;
/** Checkpoints carry a 24-hour TTL; this only catches ones the provider missed. */
const CHECKPOINT_MAX_AGE = 26 * HOUR;

const WORLDS: PreviewWorld[] = ["app-web", "acme-web", "desktop"];
const PREVIEW = /^openwork-[a-z-]+-v\d+-[0-9a-f]{40}$|^openwork-web-v\d+-[0-9a-f]{40}$/;
const LAYER = /^ow-(tools|deps|build|warm)-v1-(app-web|acme-web|desktop)-[0-9a-f]{40}$|^ow-evidence-(tools|deps)-v1-[0-9a-f]{40}$/;
const TEMPLATE = /^ow-evidence-web-v\d+-[0-9a-f]{40}$/;
const CHECKPOINT = /^ow-evidence-v1-[0-9a-f]{32}$|^ow-checkpoint-probe-[a-z0-9-]+$/;

function currentPreviewPrefixes(): string[] {
  return WORLDS.map((world) => snapshotSlug("0".repeat(40), world).slice(0, -40));
}

function touched(snapshot: CleanupSnapshot): number {
  const created = Date.parse(snapshot.createdAt);
  const used = snapshot.lastUsedAt ? Date.parse(snapshot.lastUsedAt) : Number.NaN;
  return Number.isFinite(used) && used > created ? used : created;
}

/** Plans deletions. Pure: the same inputs always produce the same plan. */
export function planCleanup(snapshots: CleanupSnapshot[], options: CleanupOptions): CleanupItem[] {
  const current = currentPreviewPrefixes();
  const plan: CleanupItem[] = [];
  const layers = new Map<string, CleanupSnapshot[]>();
  for (const snapshot of snapshots) {
    const slug = snapshot.slug ?? "";
    const idle = options.now - touched(snapshot);
    if (!slug || options.inUse.has(snapshot.id) || !Number.isFinite(idle) || idle < RECENT) continue;
    if (PREVIEW.test(slug)) {
      if (!current.some((prefix) => slug.startsWith(prefix))) plan.push({ id: snapshot.id, slug, reason: "preview from an old naming version" });
      else if (idle > PREVIEW_IDLE) plan.push({ id: snapshot.id, slug, reason: "preview not launched for a day" });
    } else if (TEMPLATE.test(slug) && !slug.startsWith(EVIDENCE_TEMPLATE_PREFIX)) {
      plan.push({ id: snapshot.id, slug, reason: "evidence template from an old naming version" });
    } else if (LAYER.test(slug) || TEMPLATE.test(slug)) {
      const group = slug.slice(0, -41);
      layers.set(group, [...(layers.get(group) ?? []), snapshot]);
    } else if (CHECKPOINT.test(slug) && options.now - Date.parse(snapshot.createdAt) > CHECKPOINT_MAX_AGE) {
      plan.push({ id: snapshot.id, slug, reason: "expired checkpoint" });
    }
  }
  for (const group of layers.values()) {
    // Keep the most recently used layer of each kind: it is what the next build reuses.
    const [, ...older] = [...group].sort((a, b) => touched(b) - touched(a));
    for (const snapshot of older) {
      if (options.now - touched(snapshot) > LAYER_IDLE) plan.push({ id: snapshot.id, slug: snapshot.slug ?? "", reason: "superseded cache layer" });
    }
  }
  return plan;
}

export function isOurs(slug: string | null | undefined): boolean {
  const value = slug ?? "";
  return PREVIEW.test(value) || LAYER.test(value) || TEMPLATE.test(value) || CHECKPOINT.test(value);
}

export async function listAllSnapshots(api: Freestyle): Promise<CleanupSnapshot[]> {
  const all: CleanupSnapshot[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await api.vms.snapshots.list({ limit: 500, offset });
    all.push(...page.snapshots);
    if (page.snapshots.length < 500 || all.length >= page.totalCount) return all;
  }
}

export async function snapshotsInUse(api: Freestyle): Promise<Set<string>> {
  const inUse = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    const page = await api.vms.list({ limit: 500, offset });
    for (const vm of page.vms) if (vm.snapshotId) inUse.add(vm.snapshotId);
    if (page.vms.length < 500 || offset + page.vms.length >= page.totalCount) return inUse;
  }
}

type SnapshotDeleter = { vms: { snapshots: Pick<Freestyle["vms"]["snapshots"], "delete"> } };

/** Deletes with bounded concurrency; the provider rate-limits bursts with 429. */
export async function deleteSnapshots(api: SnapshotDeleter, items: CleanupItem[], concurrency = 4, pause: (ms: number) => Promise<unknown> = delay) {
  const failed: { item: CleanupItem; reason: string }[] = [];
  let deleted = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      for (let attempt = 0; ; attempt++) {
        try { await api.vms.snapshots.delete(item.id); deleted++; break; }
        catch (error) {
          if (error instanceof FreestyleApiError && error.status === 404) { deleted++; break; }
          const retryable = error instanceof FreestyleApiError && (error.status === 429 || error.status >= 500);
          if (!retryable || attempt >= 5) { failed.push({ item, reason: error instanceof Error ? error.message : "unknown error" }); break; }
          await pause(Math.min(30_000, 1_000 * 2 ** attempt));
        }
      }
    }
  }));
  return { deleted, failed };
}
