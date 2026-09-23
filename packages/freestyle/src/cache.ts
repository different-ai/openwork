import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FreestyleApiError, type Freestyle, type Vm } from "freestyle";
import { execChecked, isMissing } from "./index.ts";

export interface SourceEntry { path: string; sha: string; type: string }
export interface BuildStage { stage: string; durationMs: number; cacheHit?: boolean }
export type ObserveBuild = (event: BuildStage) => void;

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}

export function dependencyInput(path: string): boolean {
  return /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.[cm]?js)$/.test(path)
    || /(^|\/)patches\//.test(path);
}

export function dependencyFingerprint(entries: SourceEntry[]): string {
  const inputs = entries.filter((entry) => entry.type === "blob" && dependencyInput(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!inputs.some((entry) => entry.path === "pnpm-lock.yaml")) throw new Error("Source tree is missing its lockfile");
  return digest(JSON.stringify(inputs.map(({ path, sha }) => [path, sha])));
}

/** Public metadata only: never check out or execute PR code on the credentialed host. */
export async function sourceTree(sha: string, request: typeof fetch = fetch): Promise<SourceEntry[]> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed commit SHA is required.");
  const response = await request(`https://api.github.com/repos/different-ai/openwork/git/trees/${sha}?recursive=1`, {
    headers: { accept: "application/vnd.github+json",
      ...(process.env.OPENWORK_PREVIEW_GITHUB_TOKEN ? { authorization: `Bearer ${process.env.OPENWORK_PREVIEW_GITHUB_TOKEN}` } : {}),
    }, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not read public dependency inputs (HTTP ${response.status})`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("tree" in value) || !Array.isArray(value.tree)
    || !("truncated" in value) || value.truncated !== false) throw new Error("Incomplete dependency input tree");
  return value.tree.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string"
      || !("sha" in entry) || typeof entry.sha !== "string" || !/^[a-f0-9]{40}$/.test(entry.sha)
      || !("type" in entry) || typeof entry.type !== "string") throw new Error("Invalid dependency input tree");
    return { path: entry.path, sha: entry.sha, type: entry.type };
  });
}

/** Immutable layers use the provider's unique builder slug as a distributed lock. */
export async function ensureLayer(input: {
  slug: string; stage: string; parent: () => Promise<string>;
  prepare: (vm: Vm) => Promise<void>; observe: ObserveBuild; ttlSeconds?: number;
}, api: Freestyle) {
  const start = performance.now();
  const builderSlug = `ow-cache-build-${digest(input.slug)}`;
  const deadline = Date.now() + 13 * 60_000;
  while (Date.now() < deadline) {
    const existing = await api.vms.snapshots.get(input.slug).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (existing) {
      input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: true });
      return existing;
    }
    const parent = await input.parent();
    let created;
    try {
      created = await api.vms.create({
        slug: builderSlug, snapshotId: parent, ttlSeconds: 1800,
        displayName: `OpenWork ${input.stage} builder`,
        metadata: { kind: "openwork-cache-builder-v1", cacheKey: digest(input.slug) },
        firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
      });
    } catch (error) {
      if (!(error instanceof FreestyleApiError) || error.status !== 409) throw error;
      const owner = await api.vms.get(builderSlug).catch((cause: unknown) => {
        if (isMissing(cause)) return null;
        throw cause;
      });
      if (!owner) {
        const completed = await api.vms.snapshots.get(input.slug).catch((cause: unknown) => {
          if (isMissing(cause)) return null;
          throw cause;
        });
        if (!completed) throw error; // Capacity conflict, not another builder.
        input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: true });
        return completed;
      }
      if (owner.metadata.kind !== "openwork-cache-builder-v1" || owner.metadata.cacheKey !== digest(input.slug)) throw error;
      await delay(2_000);
      continue;
    }
    try {
      const prepareStart = performance.now();
      await input.prepare(created.vm);
      input.observe({ stage: `${input.stage}-prepare`, durationMs: Math.round(performance.now() - prepareStart) });
      // Keep running application memory, release filesystem cache left by builds.
      // The provider otherwise materializes gigabytes of unused cached file pages.
      await execChecked(created.vm, "sync && echo 3 > /proc/sys/vm/drop_caches");
      const snapshotStart = performance.now();
      const result = await created.vm.snapshot({ slug: input.slug, displayName: `OpenWork ${input.stage}`,
        autoDeleteSeconds: 7 * 86400, ttlSeconds: input.ttlSeconds ?? 30 * 86400 });
      input.observe({ stage: `${input.stage}-snapshot`, durationMs: Math.round(performance.now() - snapshotStart) });
      input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: false });
      return result.snapshot;
    } finally {
      await created.vm.delete().catch(() => undefined); // TTL bounds failed cleanup.
    }
  }
  throw new Error(`${input.stage} cache build timed out`);
}

export function compiledFingerprint(entries: SourceEntry[]): string {
  const runtimeSource = /^(apps\/app\/(src|public)\/|ee\/apps\/(den-web\/(src|app|public)|den-api\/src|gateway\/src)\/|packages\/freestyle\/|worlds\/|evals\/|\.github\/|docs\/)/;
  return digest(JSON.stringify(entries.filter((entry) => entry.type === "blob" && !runtimeSource.test(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path)).map(({ path, sha }) => [path, sha])));
}
