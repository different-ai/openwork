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
const INERT_PATH = /^(?:\.github\/|\.opencode\/|\.warden\/|docs\/|packages\/docs\/|evals\/(?:specs|worlds|scripts|bin|results)\/|apps\/review\/|packages\/review\/|packages\/freestyle\/|scripts\/(?:prove|prepare|publish|verify|soak)-[^/]+$)|(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec|e2e\.test)\.[cm]?[jt]sx?$|\.mdx?$/;

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
export async function ensureEvidenceImage(devSha: string, api = client(), options: BuildOptions = {}) {
  if (!/^[a-f0-9]{40}$/.test(devSha)) throw new Error("A full dev commit SHA is required");
  const entries = await sourceTree(devSha, options.sourceFetch);
  return ensureLayer({ slug: `${EVIDENCE_IMAGE_PREFIX}${digest(TOOLS + DEPENDENCIES + dependencyFingerprint(entries))}`,
    stage: "evidence-image", observe: options.observe ?? (() => {}), metadata: { devSha },
    parent: async () => "freestyle/ubuntu",
    prepare: (vm) => runScript(vm, "evidence-image", `${TOOLS}\n${checkoutRecipe(devSha)}\n${DEPENDENCIES}`, options) }, api);
}

/**
 * This commit's e2e and preview world: the warm dev image, checked out at this
 * commit, installed incrementally, built, and booted. Keyed by what runs in the
 * VM, so test, review-UI, docs and CI-only commits reuse it.
 */
export async function ensureEvidenceSnapshot(sha: string, api = client(), options: EvidenceBuildOptions = {}): Promise<EvidenceTemplate> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed source SHA is required");
  const entries = await sourceTree(sha, options.sourceFetch);
  const observe = options.observe ?? (() => {});
  const files: ControllerAsset[] = ["evidence-runtime.mjs", "evidence-control.mjs", "gateway.mjs", "origins.mjs"];
  const controller = await Promise.all(files.map(readAsset));
  // Keyed by what runs in the VM, not by commit: test, review-UI, docs and CI-only
  // commits reuse the template. The copy records the fingerprint it was built for.
  const runtimeFingerprint = evidenceRuntimeFingerprint(entries);
  const template = await ensureLayer({ slug: `${EVIDENCE_TEMPLATE_PREFIX}${digest(TOOLS + DEPENDENCIES + controller.join("\n") + runtimeFingerprint)}`, stage: "evidence-world", observe, ttlSeconds: 86400,
    parent: async () => (await ensureEvidenceImage(options.imageSha ?? await devHead(options.sourceFetch), api, options)).id,
    prepare: async (vm) => {
      for (const [index, name] of files.entries()) await vm.fs.writeTextFile(`/opt/openwork-preview/${name}`, controller[index]);
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
  return { id: template.id, runtimeFingerprint };
}
