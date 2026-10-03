import { readAsset, type ControllerAsset } from "./assets.ts";
import { client } from "./index.ts";
import { runScript, type BuildOptions } from "./builder.ts";
import { toolsRecipe, dependencyRecipe, checkoutRecipe } from "./build-recipes.ts";
import { digest, sourceTree, dependencyFingerprint, ensureLayer, type SourceEntry } from "./cache.ts";

/**
 * Files that never execute inside the evidence VM. Anything not listed here is a
 * runtime input: changing it rebuilds the world. Keep this list conservative;
 * a missing exclusion only costs a rebuild, a wrong one reuses stale code.
 * Freestyle controller files that do enter the VM are digested separately.
 */
const INERT_PATH = /^(?:\.github\/|\.opencode\/|\.warden\/|docs\/|packages\/docs\/|evals\/(?:specs|worlds|scripts|bin|results)\/|apps\/review\/|packages\/review\/|packages\/freestyle\/|ee\/apps\/(?:landing|headless-runner)\/|scripts\/(?:prove|prepare|publish|verify|soak)-[^/]+$)|(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec|e2e\.test)\.[cm]?[jt]sx?$|\.mdx?$/;

/** Bump the version when the template layout changes; cleanup reclaims older ones. */
export const EVIDENCE_TEMPLATE_PREFIX = "ow-evidence-web-v3-";
/** The warm image: system tools plus a full install at a dev commit. Nothing runs. */
export const EVIDENCE_IMAGE_PREFIX = "ow-evidence-image-v1-";

export function evidenceRuntimeFingerprint(entries: SourceEntry[]): string {
  return digest(JSON.stringify(entries.filter((entry) => entry.type === "blob" && !INERT_PATH.test(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path)).map(({ path, sha, runtimeSha }) => [path, runtimeSha ?? sha])));
}

export interface EvidenceTemplate { id: string; runtimeFingerprint: string }
/** `imageSha` pins the dev commit whose warm image to start from; defaults to the dev head. */
export type EvidenceBuildOptions = BuildOptions & { imageSha?: string };

const TOOLS = toolsRecipe("acme-web") + `
cat > /opt/openwork-preview/evidence-chrome <<'CHROME'
#!/bin/sh
exec /usr/bin/google-chrome-stable --no-sandbox --disable-dev-shm-usage "$@"
CHROME
chmod 755 /opt/openwork-preview/evidence-chrome
`;
/** Incremental on the image: pnpm only adds or removes what the lockfile changed. */
const DEPENDENCIES = dependencyRecipe("acme-web").replace("pnpm install --frozen-lockfile", "pnpm install --filter @openwork/freestyle... --frozen-lockfile");

/** The newest dev commit, the source of the warm image. */
export async function devHead(request: typeof fetch = fetch): Promise<string> {
  const response = await request("https://api.github.com/repos/different-ai/openwork/commits/dev", {
    headers: { accept: "application/vnd.github.sha",
      ...(process.env.OPENWORK_PREVIEW_GITHUB_TOKEN ? { authorization: `Bearer ${process.env.OPENWORK_PREVIEW_GITHUB_TOKEN}` } : {}) },
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const sha = (await response.text()).trim();
  if (!response.ok || !/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Could not read the dev head (HTTP ${response.status})`);
  return sha;
}

/**
 * The warm image for a dev commit: tools plus a full install, keyed only by what
 * the install depends on. Most dev pushes reuse it; dev's warm-up workflow and
 * PR builds share the provider's builder lock, so it is built once.
 */
export async function ensureEvidenceImage(devSha: string, api = client(), options: BuildOptions = {}, devEntries?: SourceEntry[]) {
  if (!/^[a-f0-9]{40}$/.test(devSha)) throw new Error("A full dev commit SHA is required");
  const entries = devEntries ?? await sourceTree(devSha, options.sourceFetch);
  return ensureLayer({ slug: `${EVIDENCE_IMAGE_PREFIX}${digest(TOOLS + DEPENDENCIES + dependencyFingerprint(entries))}`,
    stage: "evidence-image", observe: options.observe ?? (() => {}), metadata: { devSha },
    parent: async () => "freestyle/ubuntu",
    prepare: (vm) => runScript(vm, "evidence-image", `${TOOLS}\n${checkoutRecipe(devSha)}\n${DEPENDENCIES}`, options) }, api);
}

/**
 * Changes the running world applies without a rebuild. Vite (app) and Next
 * (Den web) serve the checked-out sources; den-api runs once from source, so it
 * is restarted. Extend this only together with the reload or restart that
 * applies the new kind of change; anything else takes the full build.
 */
const HOT_RULES: { path: RegExp; restart?: "den-api" }[] = [
  { path: /^apps\/app\/(?:src|public)\// },
  { path: /^ee\/apps\/den-web\/(?:app|components|lib|src|public|styles|hooks)\// },
  { path: /^ee\/apps\/den-api\/src\//, restart: "den-api" },
];

/** Runtime paths (see INERT_PATH) whose content differs between two trees. */
export function runtimeChanges(from: SourceEntry[], to: SourceEntry[]): string[] {
  const key = (entry: SourceEntry) => entry.runtimeSha ?? entry.sha;
  const blobs = (entries: SourceEntry[]) => new Map(entries.filter((entry) => entry.type === "blob" && !INERT_PATH.test(entry.path)).map((entry) => [entry.path, key(entry)]));
  const a = blobs(from);
  const b = blobs(to);
  return [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort();
}

/** Whether a commit can start from dev's running world, and what to restart. */
export function fastPathDecision(changes: string[]): { fast: boolean; restart: string[]; reason: string } {
  const blocking = changes.filter((path) => !HOT_RULES.some((rule) => rule.path.test(path)));
  if (blocking.length > 0) return { fast: false, restart: [], reason: `needs a full build: ${blocking.slice(0, 3).join(", ")}${blocking.length > 3 ? ` and ${blocking.length - 3} more` : ""}` };
  const restart = [...new Set(changes.flatMap((path) => HOT_RULES.find((rule) => rule.path.test(path))?.restart ?? []))];
  const reason = changes.length === 0 ? "same runtime as dev" : `${changes.length} file(s) changed${restart.length ? `; restarting ${restart.join(", ")}` : "; applied live"}`;
  return { fast: true, restart, reason };
}

/**
 * This commit's e2e and preview world, keyed by what runs in the VM so test,
 * review-UI, docs and CI-only commits reuse it. Two ways to build it:
 * - fast: copy dev's running world, check out this commit, restart what changed
 *   (see HOT_RULES), reload the app;
 * - full: the warm dev image, checked out, installed incrementally, built, booted.
 */
export async function ensureEvidenceSnapshot(sha: string, api = client(), options: EvidenceBuildOptions = {}): Promise<EvidenceTemplate> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed source SHA is required");
  const entries = await sourceTree(sha, options.sourceFetch);
  const observe = options.observe ?? (() => {});
  const files: ControllerAsset[] = ["evidence-runtime.mjs", "evidence-control.mjs", "gateway.mjs", "origins.mjs"];
  const controller = await Promise.all(files.map(readAsset));
  const templateSlug = (fingerprint: string) => `${EVIDENCE_TEMPLATE_PREFIX}${digest(TOOLS + DEPENDENCIES + controller.join("\n") + fingerprint)}`;
  const runtimeFingerprint = evidenceRuntimeFingerprint(entries);
  // Set by parent(), read by prepare() and the fallback below.
  const state: { mode: "fast" | "full"; restart: string[] } = { mode: "full", restart: [] };
  let dev: { sha: string; entries: SourceEntry[] } | undefined;
  const devTree = async () => {
    if (!dev) {
      const devSha = options.imageSha ?? await devHead(options.sourceFetch);
      dev = { sha: devSha, entries: devSha === sha ? entries : await sourceTree(devSha, options.sourceFetch) };
    }
    return dev;
  };
  let allowFast = true;
  const build = () => ensureLayer({ slug: templateSlug(runtimeFingerprint), stage: "evidence-world", observe, ttlSeconds: 86400,
    parent: async () => {
      const { sha: devSha, entries: devEntries } = await devTree();
      const decision = devSha === sha ? { fast: false, restart: [], reason: "this is the dev commit" }
        : !allowFast ? { fast: false, restart: [], reason: "the fast path failed; see the log above" }
        : fastPathDecision(runtimeChanges(devEntries, entries));
      const devWorld = decision.fast ? await api.vms.snapshots.get(templateSlug(evidenceRuntimeFingerprint(devEntries))).catch(() => null) : null;
      const fast = decision.fast && devWorld !== null;
      observe({ stage: fast ? "path: fast (copy dev's running world)" : "path: full build", durationMs: 0, cacheHit: fast,
        reason: decision.fast && !devWorld ? "dev's running world is not built yet" : decision.reason });
      if (fast && devWorld) { state.mode = "fast"; state.restart = decision.restart; return devWorld.id; }
      state.mode = "full";
      return (await ensureEvidenceImage(devSha, api, options, devEntries)).id;
    },
    prepare: async (vm) => {
      for (const [index, name] of files.entries()) await vm.fs.writeTextFile(`/opt/openwork-preview/${name}`, controller[index]);
      if (state.mode === "fast") {
        // Keep dev's installed and built files; only tracked sources change.
        await runScript(vm, "evidence-world-fast", `cd /workspace
git fetch --depth=1 origin ${sha}
git checkout --force --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "${sha}"
sleep 2
node /opt/openwork-preview/evidence-control.mjs refresh ${state.restart.join(" ")}
printf %s ${runtimeFingerprint} > /opt/openwork-preview/runtime-fingerprint
printf %s ${sha} > /opt/openwork-preview/built-from-sha
`, options);
        return;
      }
      await vm.fs.writeTextFile("/etc/systemd/system/openwork-evidence.service", `[Unit]\nDescription=OpenWork isolated evidence web world\n[Service]\nWorkingDirectory=/workspace\nEnvironment=PATH=/opt/openwork-preview/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nExecStart=/usr/bin/env node /opt/openwork-preview/evidence-runtime.mjs\n`);
      await vm.fs.writeTextFile("/etc/systemd/system/openwork-evidence-gateway.service", `[Unit]\nDescription=Private evidence viewer\n[Service]\nExecStart=/usr/bin/env node /opt/openwork-preview/gateway.mjs\n`);
      await runScript(vm, "evidence-world", `${checkoutRecipe(sha)}
${DEPENDENCIES}
pnpm --filter @openwork-ee/den-api run build:workspace-dependencies
pnpm --filter openwork-server build
pnpm --filter @openwork/sdk build
systemctl daemon-reload
systemctl start openwork-evidence
for attempt in $(seq 1 480); do
  if systemctl is-failed --quiet openwork-evidence; then exit 1; fi
  test ! -f /opt/openwork-preview/failed-world
  if test -f /opt/openwork-preview/evidence-ready; then break; fi
  sleep 1
done
test -f /opt/openwork-preview/evidence-ready
printf %s ${runtimeFingerprint} > /opt/openwork-preview/runtime-fingerprint
printf %s ${sha} > /opt/openwork-preview/built-from-sha
systemctl start openwork-evidence-gateway
`, options);
    },
  }, api);
  let template;
  try {
    template = await build();
  } catch (error) {
    // The fast path is an optimisation: if applying the change to dev's running
    // world fails, build the world in full instead of failing the PR.
    if (state.mode !== "fast") throw error;
    observe({ stage: "fast path failed; building in full", durationMs: 0, reason: error instanceof Error ? error.message : String(error) });
    allowFast = false;
    template = await build();
  }
  return { id: template.id, runtimeFingerprint };
}
