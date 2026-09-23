import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Vm } from "freestyle";
import { client, execChecked, findSnapshot, snapshotSlug, type PreviewWorld } from "./index.ts";
import { compiledFingerprint, dependencyFingerprint, dependencyInput, digest, ensureLayer, sourceTree, type ObserveBuild } from "./cache.ts";
import { checkoutRecipe, compiledRecipe, dependencyRecipe, toolsRecipe } from "./build-recipes.ts";

export interface BuildOptions {
  observe?: ObserveBuild;
  sourceFetch?: typeof fetch;
  diagnostic?: (stage: string, log: string) => Promise<void>;
}

async function runScript(vm: Vm, stage: string, script: string, options: BuildOptions) {
  const root = `/opt/openwork-preview/${stage}`;
  await execChecked(vm, "mkdir -p /opt/openwork-preview");
  await vm.fs.writeTextFile(`${root}.sh`, `#!/bin/bash
set -euo pipefail
exec > ${root}.log 2>&1
trap 'touch ${root}.failed' ERR
rm -f ${root}.ready ${root}.failed
export pnpm_config_verify_deps_before_run=false
${script}
touch ${root}.ready
`);
  await execChecked(vm, `systemd-run --collect --unit=openwork-${stage} /bin/bash ${root}.sh`);
  const deadline = Date.now() + 11 * 60_000;
  while (Date.now() < deadline) {
    const state = (await execChecked(vm, `if test -f ${root}.failed; then echo failed; elif test -f ${root}.ready; then echo ready; else echo building; fi`)).trim();
    if (state === "ready") return;
    if (state === "failed") {
      if (options.diagnostic) await options.diagnostic(stage, await vm.fs.readTextFile(`${root}.log`));
      throw new Error(`Snapshot ${stage} failed. Private builder log: ${root}.log`);
    }
    await delay(1_000);
  }
  if (options.diagnostic) await options.diagnostic(stage, await vm.fs.readTextFile(`${root}.log`));
  throw new Error(`Snapshot ${stage} exceeded 11 minutes`);
}

/** Immutable tools/dependencies are shared; the running world always belongs to one exact commit. */
export async function ensureSnapshot(sha: string, api = client(), log: (message: string) => void = () => {}, world: PreviewWorld = "app-web", options: BuildOptions = {}) {
  const slug = snapshotSlug(sha, world);
  const observe: ObserveBuild = (event) => { log(JSON.stringify(event)); options.observe?.(event); };
  const existing = await findSnapshot(sha, api, world);
  if (existing) { observe({ stage: "world", durationMs: 0, cacheHit: true }); return existing; }
  const entries = await sourceTree(sha, options.sourceFetch);
  const tools = toolsRecipe(world);
  const dependencies = dependencyRecipe(world);
  const toolsSlug = `ow-tools-v1-${world}-${digest(tools)}`;
  const depsSlug = `ow-deps-v1-${world}-${digest(toolsSlug + dependencies + dependencyFingerprint(entries))}`;
  const deps = await ensureLayer({ slug: depsSlug, stage: "dependencies", observe,
    parent: async () => (await ensureLayer({ slug: toolsSlug, stage: "tools", observe,
      parent: async () => "freestyle/ubuntu",
      prepare: async (vm) => runScript(vm, "tools", tools, options),
    }, api)).id,
    prepare: async (vm) => {
      // Remove application source before installing the shared layer. Only
      // fingerprinted inputs and immutable registry dependencies may affect it.
      const inputs = entries.filter((entry) => entry.type === "blob" && dependencyInput(entry.path)).map((entry) => entry.path);
      await vm.fs.writeTextFile("/opt/openwork-preview/dependency-inputs.json", JSON.stringify(inputs));
      await runScript(vm, "dependencies", `${checkoutRecipe(sha)}
node --input-type=module - <<'NODE'
import { readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const keep = new Set(JSON.parse(await readFile('/opt/openwork-preview/dependency-inputs.json', 'utf8')));
for (const path of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0').filter(Boolean)) {
  if (!keep.has(path)) await rm(path, { force: true });
}
NODE
${dependencies}`, options);
    },
  }, api);
  const compile = compiledRecipe(world);
  const compiledSlug = `ow-compiled-v1-${world}-${digest(depsSlug + compile + compiledFingerprint(entries))}`;
  const compiled = await ensureLayer({ slug: compiledSlug, stage: "compiled", observe,
    parent: async () => deps.id,
    prepare: async (vm) => runScript(vm, "compiled", `${checkoutRecipe(sha)}\n${compile}`, options),
  }, api);
  return ensureLayer({ slug, stage: "world", observe, ttlSeconds: 7 * 86400,
    parent: async () => compiled.id,
    prepare: async (vm) => {
      log(`Preparing ${world} at ${sha} from cached dependencies`);
      for (const [target, source] of [
        ["gateway.mjs", "gateway.mjs"], ["runtime.mjs", world === "acme-web" ? "acme-runtime.mjs" : "runtime.mjs"],
        ["health.mjs", "health.mjs"], ["origins.mjs", "origins.mjs"], ["resume.mjs", "resume.mjs"], ["desktop.mjs", "desktop.mjs"],
      ]) {
        await vm.fs.writeTextFile(`/opt/openwork-preview/${target}`, await readFile(new URL(`./${source}`, import.meta.url), "utf8"));
      }
      await vm.fs.writeTextFile("/etc/systemd/system/openwork-preview-runtime.service", `[Unit]
Description=OpenWork isolated preview runtime
[Service]
Type=${world === "app-web" ? "oneshot" : "simple"}
RemainAfterExit=${world === "app-web" ? "yes" : "no"}
WorkingDirectory=/workspace
Environment=PATH=/opt/openwork-preview/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/env node /opt/openwork-preview/runtime.mjs
`);
      await vm.fs.writeTextFile("/etc/systemd/system/openwork-preview-gateway.service", `[Unit]
Description=OpenWork private preview gateway
[Service]
ExecStart=/usr/bin/env node /opt/openwork-preview/gateway.mjs
Restart=on-failure
[Install]
WantedBy=multi-user.target
`);
      await runScript(vm, "world", `
stage_start=$(date +%s%3N)
mark() { now=$(date +%s%3N); printf '{"stage":"%s","durationMs":%s}\\n' "$1" "$((now-stage_start))" >> /opt/openwork-preview/build-stages.jsonl; stage_start=$now; }
${checkoutRecipe(sha)}
mark checkout
tar -xf /opt/openwork-preview/compiled.tar -C /workspace
mark compile
export PATH="/opt/openwork-preview/tools/node_modules/.bin:$PATH"
systemctl daemon-reload
systemctl start openwork-preview-runtime
${world === "app-web" ? "curl --retry 20 --retry-delay 1 --retry-all-errors -fsS http://127.0.0.1:5178/ >/dev/null" : `for attempt in $(seq 1 480); do
  test ! -f /opt/openwork-preview/failed-world
  if test -f /opt/openwork-preview/ready-world; then break; fi
  sleep 1
done
test -f /opt/openwork-preview/ready-world`}
node /opt/openwork-preview/health.mjs
systemctl enable --now openwork-preview-gateway
mark boot-and-verify
`, options);
      const timings = await vm.fs.readTextFile("/opt/openwork-preview/build-stages.jsonl")
        + (world === "acme-web" ? await vm.fs.readTextFile("/opt/openwork-preview/runtime-stages.jsonl") : "");
      for (const line of timings.trim().split("\n")) {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || !("stage" in value) || typeof value.stage !== "string"
          || !["checkout", "compile", "boot-and-verify", "world-services", "gateway-probe", "den-pages", "app-modules", "desktop"].includes(value.stage) || !("durationMs" in value)
          || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) throw new Error("Invalid build timing");
        observe({ stage: value.stage, durationMs: value.durationMs });
      }
    },
  }, api);
}
