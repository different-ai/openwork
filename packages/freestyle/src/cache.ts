import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FreestyleApiError, type Freestyle, type Vm } from "freestyle";
import { execChecked, isMissing } from "./index.ts";

export interface SourceEntry { path: string; sha: string; type: string; installSha?: string; runtimeSha?: string }
export interface BuildStage { stage: string; durationMs: number; cacheHit?: boolean }
export type ObserveBuild = (event: BuildStage) => void;

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}

/** Ignore only known inert metadata; unknown package fields remain conservative. */
export function manifestFingerprints(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid package manifest");
  const metadata = new Set(["description", "keywords", "author", "contributors", "license", "homepage", "bugs", "repository"]);
  const runtime: Record<string, unknown> = {};
  const install: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (metadata.has(key)) continue;
    if (key === "scripts") {
      if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error("Invalid package scripts");
      const scripts = Object.entries(field).filter(([name]) => !/^(pre|post)?(test|lint|typecheck)(:|$)/.test(name)).sort(([a], [b]) => a.localeCompare(b));
      if (scripts.length) runtime[key] = Object.fromEntries(scripts);
    } else { runtime[key] = field; install[key] = field; }
  }
  return { installSha: digest(JSON.stringify(install)), runtimeSha: digest(JSON.stringify(runtime)) };
}

function worldSource(path: string, world: "app-web" | "acme-web") {
  // app-web runs the hosted Den proxy, never the local Den/Gateway or eval runtime.
  return world !== "app-web" || !/^(ee\/apps\/(den-web|den-api|gateway)\/|evals\/|worlds\/acme-web\.)/.test(path);
}

export function dependencyInput(path: string): boolean {
  return /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.[cm]?js)$/.test(path)
    || /(^|\/)patches\//.test(path);
}

export function dependencyFingerprint(entries: SourceEntry[]): string {
  const inputs = entries.filter((entry) => entry.type === "blob" && dependencyInput(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!inputs.some((entry) => entry.path === "pnpm-lock.yaml")) throw new Error("Source tree is missing its lockfile");
  return digest(JSON.stringify(inputs.map(({ path, sha, installSha }) => [path, installSha ?? sha])));
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
  const entries = value.tree.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string"
      || !("sha" in entry) || typeof entry.sha !== "string" || !/^[a-f0-9]{40}$/.test(entry.sha)
      || !("type" in entry) || typeof entry.type !== "string") throw new Error("Invalid dependency input tree");
    return { path: entry.path, sha: entry.sha, type: entry.type };
  });
  const result: SourceEntry[] = [...entries];
  const manifests = entries.filter((entry) => entry.type === "blob" && /(^|\/)package\.json$/.test(entry.path));
  // Bound concurrent public reads. Only JSON is parsed; PR code never executes here.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, manifests.length) }, async () => {
    while (next < manifests.length) {
      const entry = manifests[next++];
      const response = await request(`https://raw.githubusercontent.com/different-ai/openwork/${sha}/${entry.path}`, {
        redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Could not read package inputs (HTTP ${response.status})`);
      Object.assign(result[entries.indexOf(entry)], manifestFingerprints(await response.json()));
    }
  }));
  return result;
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
      const cleanupStart = performance.now();
      // The snapshot is materialized before this point. Deletion must not hold up
      // the next layer. The builder's provider TTL also covers host termination.
      void created.vm.delete().catch(() => undefined).then(() => {
        input.observe({ stage: `${input.stage}-cleanup`, durationMs: Math.round(performance.now() - cleanupStart) });
      });
    }
  }
  throw new Error(`${input.stage} cache build timed out`);
}

export function compiledFingerprint(entries: SourceEntry[], world: "app-web" | "acme-web" = "acme-web"): string {
  const runtimeSource = /^(apps\/app\/(src|public)\/|ee\/apps\/(den-web\/(src|app|public)|den-api\/src|gateway\/src)\/|packages\/freestyle\/|worlds\/|evals\/|\.github\/|docs\/)/;
  return digest(JSON.stringify(entries.filter((entry) => entry.type === "blob" && worldSource(entry.path, world) && !runtimeSource.test(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path)).map(({ path, sha, runtimeSha }) => [path, runtimeSha ?? sha])));
}


/** An interrupted response must not start a second build in the resumed guest. */
export async function startBuildUnit(vm: Vm, stage: string, diagnostic?: (stage: string, log: string) => Promise<void>): Promise<void> {
  if (!/^[a-z-]+$/.test(stage)) throw new Error("Invalid build stage");
  const root = `/opt/openwork-preview/${stage}`;
  const command = `if test -f ${root}.ready || test -f ${root}.failed || systemctl is-active --quiet openwork-${stage}.service; then exit 0; fi; systemd-run --collect --unit=openwork-${stage} /bin/bash ${root}.sh`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await vm.exec({ command, timeoutMs: 30_000, linuxUser: "root" });
    if (result.statusCode === 0) return;
    if (result.statusCode !== null) {
      if (diagnostic) await diagnostic(stage, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      throw new Error(`Could not start snapshot ${stage} unit (${result.statusCode})`);
    }
    await delay(250);
  }
  throw new Error(`Snapshot ${stage} unit could not start after resume`);
}


/** These files run in development servers that reload them after checkout. */
export function runningFingerprint(entries: SourceEntry[], world: "app-web" | "acme-web" = "acme-web"): string {
  const refreshed = /^(apps\/app\/(src|public)\/|ee\/apps\/den-web\/(components|public|styles)\/|\.github\/|docs\/)/;
  return digest(JSON.stringify(entries.filter((entry) => entry.type === "blob" && worldSource(entry.path, world) && !refreshed.test(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path)).map(({ path, sha, runtimeSha }) => [path, runtimeSha ?? sha])));
}
