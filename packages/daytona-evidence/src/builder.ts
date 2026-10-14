import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { EVIDENCE_KIND } from "./kinds.ts";
import { readAsset } from "@openwork/freestyle/assets";
import { checkoutRecipe } from "@openwork/freestyle/build-recipes";
import { dependencyFingerprint, digest, sourceTree, type ObserveBuild, type SourceEntry } from "@openwork/freestyle/cache";
import {
  devHead, evidenceRuntimeFingerprint, fastPathDecision, runtimeChanges,
  EVIDENCE_CONTROLLER_FILES, EVIDENCE_DEPENDENCIES_RECIPE, EVIDENCE_TOOLS_RECIPE,
} from "@openwork/freestyle/evidence-builder";
import { DaytonaApi, DaytonaApiError, type Sandbox } from "./api.ts";

/**
 * Daytona builds the same evidence world as Freestyle, with the same steps inside
 * the VM, in three cached layers:
 * - base: plain Ubuntu as a Linux VM image (Linux VMs can save memory);
 * - image: tools and a full dependency install at a dev commit (files only);
 * - world: this commit checked out, built, booted and signed in, saved running.
 * Bump a prefix when its layout changes; cleanup reclaims older ones.
 */
export const DAYTONA_BASE_PREFIX = "ow-dy-base-ubuntu2404-";
export const DAYTONA_IMAGE_PREFIX = "ow-dy-evidence-image-v1-";
export const DAYTONA_TEMPLATE_PREFIX = "ow-dy-evidence-web-v1-";
const BUILDER_KIND = "openwork-daytona-builder-v1";
/** Largest VM our Daytona organization allows. */
const VM_SIZE = { cpu: 4, memory: 8, disk: 10 };
const ROOT = "/opt/openwork-preview";

const NODE_VERSION = "v24.21.0";
/** From https://nodejs.org/dist/v24.21.0/SHASUMS256.txt (node-v24.21.0-linux-x64.tar.xz). */
const NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";

/** Node 24, Bun and git on plain Ubuntu; Freestyle's base image ships them. */
const BASE_RECIPE = `export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg git xz-utils
# Pinned Node release, verified against a checksum in this file before it runs as root.
curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz
echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner
rm /tmp/node.tar.xz
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24 or newer is required")'
# openwork-server's build bundles its plugins with Bun.
npm install --global bun@1.3.14
bun --version`;
/** Named by its recipe, so a recipe change builds a new base (and everything above it). */
export const DAYTONA_BASE_SNAPSHOT = `${DAYTONA_BASE_PREFIX}${digest(BASE_RECIPE).slice(0, 16)}`;

/** Free filesystem cache before saving, and keep apt archives out of the image. */
const SLIM_RECIPE = `apt-get clean
rm -rf /var/lib/apt/lists/* /root/.cache/node-gyp /tmp/* || true`;

export interface DaytonaBuildOptions {
  observe?: ObserveBuild;
  sourceFetch?: typeof fetch;
  diagnostic?: (stage: string, log: string) => Promise<void>;
  /** The dev commit whose warm image to start from; defaults to the dev head. */
  imageSha?: string;
  /** CI-only ownership of disposable worlds, including interrupted creation/build. */
  previewOwner?: string;
}

export interface DaytonaEvidenceTemplate { name: string; runtimeFingerprint: string }

/** Runs a build script as a transient systemd unit and polls its marker files; exec calls are short. */
export async function runScript(api: DaytonaApi, sandbox: Sandbox, stage: string, script: string, options: DaytonaBuildOptions, deadlineMs = 25 * 60_000) {
  if (!/^[a-z-]+$/.test(stage)) throw new Error("Invalid build stage");
  const root = `${ROOT}/${stage}`;
  await api.execChecked(sandbox, `mkdir -p ${ROOT}`);
  await api.writeFile(sandbox, `${root}.sh`, `#!/bin/bash
set -euo pipefail
exec > ${root}.log 2>&1
trap 'touch ${root}.failed' ERR
rm -f ${root}.ready ${root}.failed
export HOME=/root
export pnpm_config_verify_deps_before_run=false
${script}
touch ${root}.ready
`);
  await api.execChecked(sandbox, `systemd-run --collect --unit=openwork-${stage} /bin/bash ${root}.sh`);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const state = (await api.exec(sandbox, `if test -f ${root}.failed; then echo failed; elif test -f ${root}.ready; then echo ready; else echo building; fi`)).output.trim();
    if (state === "ready") return;
    if (state === "failed") {
      if (options.diagnostic) {
        const runtime = stage.startsWith("evidence-world") ? (await api.exec(sandbox, "journalctl -u openwork-evidence --no-pager -n 100")).output : "";
        await options.diagnostic(stage, `${await api.readFile(sandbox, `${root}.log`) ?? ""}${runtime}`);
      }
      throw new Error(`Daytona ${stage} failed. Private builder log: ${root}.log`);
    }
    await delay(3_000);
  }
  if (options.diagnostic) await options.diagnostic(stage, await api.readFile(sandbox, `${root}.log`) ?? "");
  throw new Error(`Daytona ${stage} exceeded ${Math.round(deadlineMs / 60_000)} minutes`);
}

/**
 * A cached layer: reuse the snapshot when it exists, otherwise build it in a
 * builder VM and save it. The builder's unique name is the lock between
 * concurrent builds (a dev warm-up and several PRs).
 */
interface LayerInput {
  name: string; stage: string; parent: () => Promise<string>;
  prepare: (sandbox: Sandbox) => Promise<void>;
  /** Save memory too (running processes). Otherwise files only, from a stopped VM. */
  withMemory: boolean;
  observe: ObserveBuild; labels?: Record<string, string>;
}

export async function ensureLayer(api: DaytonaApi, input: LayerInput): Promise<string> {
  const start = performance.now();
  const builderName = `ow-dy-build-${digest(input.name).slice(0, 24)}`;
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const existing = await api.getSnapshot(input.name);
    if (existing?.state === "active") {
      input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: true });
      return existing.name;
    }
    if (existing && !/error|fail/.test(existing.state)) { await api.waitForSnapshot(input.name); continue; }
    if (existing) await api.deleteSnapshot(existing.id);
    const owner = await api.getSandbox(builderName);
    if (owner) {
      // Another build of this layer is running; wait for it. A stuck or dead builder is replaced.
      const age = owner.createdAt ? Date.now() - Date.parse(owner.createdAt) : 0;
      if (owner.labels.kind !== BUILDER_KIND) throw new Error(`Refusing to reuse unrelated sandbox ${builderName}`);
      if (["error", "build_failed", "stopped", "archived"].includes(owner.state) || age > 60 * 60_000) await api.deleteSandbox(owner.id);
      else await delay(5_000);
      continue;
    }
    const parent = await input.parent();
    let created: Sandbox;
    try {
      created = await api.createSandbox({ name: builderName, snapshot: parent, labels: { ...input.labels, kind: BUILDER_KIND, layer: digest(input.name).slice(0, 24) },
        // Polling keeps a live build active; a dead controller's builder stops, then is deleted.
        autoStopMinutes: 30, autoDeleteMinutes: 60 });
    } catch (error) {
      // Lost the race for the builder name; loop to wait for the winner.
      if (error instanceof DaytonaApiError && (error.status === 409 || /already exists/i.test(error.message))) { await delay(2_000); continue; }
      throw error;
    }
    try {
      const sandbox = await api.waitForSandbox(created.id, ["started"]);
      const prepareStart = performance.now();
      await input.prepare(sandbox);
      input.observe({ stage: `${input.stage}-prepare`, durationMs: Math.round(performance.now() - prepareStart) });
      await api.execChecked(sandbox, "sh -c 'sync && echo 3 > /proc/sys/vm/drop_caches'");
      const snapshotStart = performance.now();
      if (!input.withMemory) {
        await api.stopSandbox(sandbox.id);
        await api.waitForSandbox(sandbox.id, ["stopped"]);
      }
      await api.snapshotSandbox(sandbox.id, input.name, input.withMemory);
      await api.waitForSnapshot(input.name);
      input.observe({ stage: `${input.stage}-snapshot`, durationMs: Math.round(performance.now() - snapshotStart) });
      input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: false });
      return input.name;
    } finally {
      // Awaited: a failing CI step exits right after, and a builder left running holds the lock.
      await api.deleteSandbox(created.id).catch(() => undefined);
    }
  }
  throw new Error(`Daytona ${input.stage} build timed out`);
}

/** Plain Ubuntu at our largest VM size, with Node 24. Built once. */
export async function ensureBase(api: DaytonaApi, options: DaytonaBuildOptions = {}): Promise<string> {
  const observe = options.observe ?? (() => {});
  const plain = `${DAYTONA_BASE_SNAPSHOT}-plain`;
  return ensureLayer(api, { name: DAYTONA_BASE_SNAPSHOT, stage: "daytona-base", observe, withMemory: false,
    parent: async () => {
      const existing = await api.getSnapshot(plain);
      if (!existing) await api.createImageSnapshot({ name: plain, image: "ubuntu:24.04", ...VM_SIZE });
      await api.waitForSnapshot(plain);
      return plain;
    },
    prepare: (sandbox) => runScript(api, sandbox, "daytona-base", `${BASE_RECIPE}\n${SLIM_RECIPE}`, options),
  });
}

/** Tools and a full install at a dev commit, keyed by what the install depends on. */
export async function ensureImage(api: DaytonaApi, devSha: string, options: DaytonaBuildOptions = {}, devEntries?: SourceEntry[]): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(devSha)) throw new Error("A full dev commit SHA is required");
  const entries = devEntries ?? await sourceTree(devSha, options.sourceFetch);
  return ensureLayer(api, {
    name: `${DAYTONA_IMAGE_PREFIX}${digest(BASE_RECIPE + EVIDENCE_TOOLS_RECIPE + EVIDENCE_DEPENDENCIES_RECIPE + dependencyFingerprint(entries))}`,
    stage: "daytona-image", observe: options.observe ?? (() => {}), withMemory: false, labels: { devSha },
    parent: () => ensureBase(api, options),
    prepare: (sandbox) => runScript(api, sandbox, "daytona-image", `${EVIDENCE_TOOLS_RECIPE}\n${checkoutRecipe(devSha)}\n${EVIDENCE_DEPENDENCIES_RECIPE}\n${SLIM_RECIPE}\ndf -h /`, options),
  });
}

/**
 * The viewer and Chrome's remote-control port are reached through Daytona's
 * private per-port URLs, which rewrite the Host header. One gateway per port,
 * each pinned to its service, keeps the same access-cookie check as Freestyle.
 */
const GATEWAY_UNITS = `cdp_port=$(node -e 'console.log(new URL(JSON.parse(require("fs").readFileSync("/opt/openwork-preview/services.json","utf8")).cdp).port)')
cat > /etc/systemd/system/openwork-evidence-gateway.service <<UNIT
[Unit]
Description=Private evidence viewer (port 8080)
[Service]
Environment=OPENWORK_PREVIEW_GATEWAY_PORT=8080 OPENWORK_PREVIEW_UPSTREAM_PORT=6081
ExecStart=/usr/bin/env node /opt/openwork-preview/gateway.mjs
UNIT
cat > /etc/systemd/system/openwork-evidence-cdp.service <<UNIT
[Unit]
Description=Private browser remote control (port 8081)
[Service]
Environment=OPENWORK_PREVIEW_GATEWAY_PORT=8081 OPENWORK_PREVIEW_UPSTREAM_PORT=$cdp_port
ExecStart=/usr/bin/env node /opt/openwork-preview/gateway.mjs
UNIT
systemctl daemon-reload
systemctl start openwork-evidence-gateway openwork-evidence-cdp`;

/**
 * This commit's evidence world, saved running. Like Freestyle: copy dev's running
 * world and apply the change when only hot-reloadable files changed, otherwise
 * build in full from the warm dev image.
 */
async function buildEvidenceWorld<Result>(sha: string, api: DaytonaApi, options: DaytonaBuildOptions,
  buildLayer: (input: LayerInput) => Promise<Result>): Promise<{ result: Result; runtimeFingerprint: string }> {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed source SHA is required");
  const devShaPromise = options.imageSha ? Promise.resolve(options.imageSha) : devHead(options.sourceFetch);
  const devEntriesPromise = devShaPromise.then((devSha) => devSha === sha ? null : sourceTree(devSha, options.sourceFetch));
  devEntriesPromise.catch(() => undefined);
  const entries = await sourceTree(sha, options.sourceFetch);
  const observe = options.observe ?? (() => {});
  const controller = await Promise.all(EVIDENCE_CONTROLLER_FILES.map(readAsset));
  const templateName = (fingerprint: string) => `${DAYTONA_TEMPLATE_PREFIX}${digest(BASE_RECIPE + EVIDENCE_TOOLS_RECIPE + EVIDENCE_DEPENDENCIES_RECIPE + GATEWAY_UNITS + controller.join("\n") + fingerprint)}`;
  const runtimeFingerprint = evidenceRuntimeFingerprint(entries);
  const state: { mode: "fast" | "full"; restart: string[] } = { mode: "full", restart: [] };
  let allowFast = true;
  const build = () => buildLayer({ name: templateName(runtimeFingerprint), stage: "daytona-world", observe, withMemory: true, labels: { sourceSha: sha },
    parent: async () => {
      const devSha = await devShaPromise;
      const devEntries = (await devEntriesPromise) ?? entries;
      const decision = devSha === sha ? { fast: false, restart: [], reason: "this is the dev commit" }
        : !allowFast ? { fast: false, restart: [], reason: "the fast path failed; see the log above" }
        : fastPathDecision(runtimeChanges(devEntries, entries));
      const devWorld = decision.fast ? await api.getSnapshot(templateName(evidenceRuntimeFingerprint(devEntries))) : null;
      const fast = decision.fast && devWorld?.state === "active";
      observe({ stage: fast ? "path: fast (copy dev's running world)" : "path: full build", durationMs: 0, cacheHit: fast,
        reason: decision.fast && !fast ? "dev's running world is not built yet" : decision.reason });
      if (fast && devWorld) { state.mode = "fast"; state.restart = decision.restart; return devWorld.name; }
      state.mode = "full";
      return ensureImage(api, devSha, options, devEntries);
    },
    prepare: async (sandbox) => {
      if (state.mode === "fast") {
        await runScript(api, sandbox, "evidence-world-fast", `cd /workspace
git config remote.origin.promisor true
git config remote.origin.partialclonefilter blob:none
git fetch --depth=1 --filter=blob:none origin ${sha}
git checkout --force --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "${sha}"
sleep 0.3
node ${ROOT}/evidence-control.mjs refresh ${state.restart.join(" ")}
printf %s ${runtimeFingerprint} > ${ROOT}/runtime-fingerprint
printf %s ${sha} > ${ROOT}/built-from-sha
`, options, 4 * 60_000);
        return;
      }
      for (const [index, name] of EVIDENCE_CONTROLLER_FILES.entries()) await api.writeFile(sandbox, `${ROOT}/${name}`, controller[index]);
      await api.writeFile(sandbox, "/etc/systemd/system/openwork-evidence.service", `[Unit]\nDescription=OpenWork isolated evidence web world\n[Service]\nWorkingDirectory=/workspace\nEnvironment=PATH=${ROOT}/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nExecStart=/usr/bin/env node ${ROOT}/evidence-runtime.mjs\n`);
      await runScript(api, sandbox, "evidence-world", `${checkoutRecipe(sha)}
${EVIDENCE_DEPENDENCIES_RECIPE}
pnpm --filter @openwork-ee/den-api run build:workspace-dependencies
pnpm --filter openwork-server build
pnpm --filter @openwork/sdk build
systemctl daemon-reload
systemctl start openwork-evidence
for attempt in $(seq 1 480); do
  if systemctl is-failed --quiet openwork-evidence; then exit 1; fi
  test ! -f ${ROOT}/failed-world
  if test -f ${ROOT}/evidence-ready; then break; fi
  sleep 1
done
test -f ${ROOT}/evidence-ready
printf %s ${runtimeFingerprint} > ${ROOT}/runtime-fingerprint
printf %s ${sha} > ${ROOT}/built-from-sha
${GATEWAY_UNITS}
df -h /
free -m
`, options);
    },
  });
  let result: Result;
  try {
    result = await build();
  } catch (error) {
    if (state.mode !== "fast") throw error;
    observe({ stage: "fast path failed; building in full", durationMs: 0, reason: error instanceof Error ? error.message : String(error) });
    allowFast = false;
    result = await build();
  }
  return { result, runtimeFingerprint };
}

/** Dev warm-up and reusable previews still save their running template under the layer lock. */
export async function ensureEvidenceTemplate(sha: string, api = new DaytonaApi(), options: DaytonaBuildOptions = {}): Promise<DaytonaEvidenceTemplate> {
  const built = await buildEvidenceWorld(sha, api, options, (input) => ensureLayer(api, input));
  return { name: built.result, runtimeFingerprint: built.runtimeFingerprint };
}

export type DaytonaEvidenceLaunch = DaytonaEvidenceTemplate | { sandbox: Sandbox; runtimeFingerprint: string };

/**
 * PR-only world: reuse an active template if present, otherwise prepare a unique
 * test-owned VM and hand it directly to the launcher. Never mutate a shared
 * builder or save a disposable template. Base/image builds retain their locks.
 */
export async function prepareEvidenceWorld(sha: string, api = new DaytonaApi(), options: DaytonaBuildOptions = {}): Promise<DaytonaEvidenceLaunch> {
  const built = await buildEvidenceWorld(sha, api, options, (input) => prepareWorldLayer(api, input, sha, options.previewOwner));
  return { ...built.result, runtimeFingerprint: built.runtimeFingerprint };
}

export async function prepareWorldLayer(api: DaytonaApi, input: LayerInput, sourceSha: string, previewOwner?: string): Promise<{ name: string } | { sandbox: Sandbox }> {
  const start = performance.now();
  const existing = await api.getSnapshot(input.name);
  if (existing?.state === "active") {
    input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: true });
    return { name: existing.name };
  }
  // A concurrent warm-up owns its builder and snapshot. Do not wait on, adopt,
  // delete, or change either: this run gets an independent VM from its parent.
  const parent = await input.parent();
  const name = `ow-dy-evidence-${randomUUID().replaceAll("-", "")}`;
  const created = await api.createSandbox({ name, snapshot: parent,
    labels: { kind: EVIDENCE_KIND, sourceSha, ...(previewOwner ? { previewOwner, previewSource: name } : {}) }, autoStopMinutes: 30, autoDeleteMinutes: 0 });
  try {
    const sandbox = await api.waitForSandbox(created.id, ["started"]);
    const prepareStart = performance.now();
    await input.prepare(sandbox);
    input.observe({ stage: `${input.stage}-prepare`, durationMs: Math.round(performance.now() - prepareStart) });
    // Match template preparation: do not carry build filesystem caches into
    // the journey's later memory checkpoints.
    await api.execChecked(sandbox, "sh -c 'sync && echo 3 > /proc/sys/vm/drop_caches'");
    input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: false,
      reason: "ephemeral PR world; template save omitted" });
    return { sandbox };
  } catch (error) {
    await api.deleteSandbox(created.id).catch(() => undefined);
    throw error;
  }
}
