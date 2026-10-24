import { randomUUID } from "node:crypto";
import { EVIDENCE_KIND } from "./kinds.ts";
import { readAsset } from "@openwork/freestyle/assets";
import { checkoutRecipe } from "@openwork/freestyle/build-recipes";
import { dependencyFingerprint, digest, sourceTree, type ObserveBuild, type SourceEntry } from "@openwork/freestyle/cache";
import {
  devHead, evidenceRuntimeFingerprint, fastPathDecision, runtimeChanges,
  EVIDENCE_CONTROLLER_FILES, EVIDENCE_DEPENDENCIES_RECIPE, EVIDENCE_TOOLS_RECIPE,
} from "@openwork/freestyle/evidence-builder";
import { DaytonaApi, DaytonaApiError, type Sandbox } from "./api.ts";
import { LOCALHOST_RECIPE } from "./localhost.ts";
import { boundedDiagnostic, inspectGuest, requireLocalEvidenceReady } from "./health.ts";
import { buildBudget, builderIsStale, describeBuilder, minutes, progressReporter, type BuildBudget, type BuildClock, type BuildProgress } from "./build-budget.ts";

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

const NODE_VERSION = "v24.22.1";
/** From https://nodejs.org/dist/v24.22.1/SHASUMS256.txt (node-v24.22.1-linux-x64.tar.xz). */
const NODE_SHA256 = "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6";

/** Node 24, Bun and git on plain Ubuntu; Freestyle's base image ships them. */
const BASE_RECIPE = `export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg git xz-utils
# Pinned Node release, verified against a checksum in this file before it runs as root.
curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz
echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner
rm /tmp/node.tar.xz
test "$(node --version)" = ${NODE_VERSION}
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
  /**
   * When this whole preparation must be over (clock ms), usually just inside
   * the CI step's limit. Every wait stops early enough to print why and fail,
   * instead of being cancelled with no output. Unset: each layer gets
   * `BUILD_TIMING.defaultBudgetMs`.
   */
  deadline?: number;
  clock?: BuildClock;
  /** "Still waiting" lines: which layer, on what (builder, snapshot, script), and how long is left. */
  progress?: (event: BuildProgress) => void;
}

export interface DaytonaEvidenceTemplate { name: string; runtimeFingerprint: string }

/** Runs a build script as a transient systemd unit and polls its marker files; exec calls are short. */
export async function runScript(api: DaytonaApi, sandbox: Sandbox, stage: string, script: string, options: DaytonaBuildOptions, deadlineMs = 25 * 60_000) {
  if (!/^[a-z-]+$/.test(stage)) throw new Error("Invalid build stage");
  const budget = buildBudget(options);
  const limitMs = budget.cap(deadlineMs);
  const progress = progressReporter(budget, options.progress);
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
  const deadline = budget.clock.now() + limitMs;
  while (budget.clock.now() < deadline) {
    // A short exec timeout keeps one stalled poll from running past the deadline.
    const state = (await api.exec(sandbox, `if test -f ${root}.failed; then echo failed; elif test -f ${root}.ready; then echo ready; else echo building; fi`, 20)).output.trim();
    if (state === "ready") return;
    if (state === "failed") {
      await reportBuildFailure(api, sandbox, stage, options);
      throw new Error(`Daytona ${stage} failed. Private builder log: ${root}.log`);
    }
    progress({ stage, waiting: "script" });
    await budget.clock.sleep(3_000);
  }
  await reportBuildFailure(api, sandbox, stage, options);
  throw new Error(limitMs < deadlineMs
    ? `Daytona ${stage} was still building when this job's preparation budget ran out (${minutes(limitMs)} of its ${minutes(deadlineMs)} limit)`
    : `Daytona ${stage} exceeded ${Math.round(deadlineMs / 60_000)} minutes`);
}

async function reportBuildFailure(api: DaytonaApi, sandbox: Sandbox, stage: string, options: DaytonaBuildOptions) {
  const diagnostic = options.diagnostic;
  if (!diagnostic) return;
  await boundedDiagnostic(async () => {
    const tail = (await api.exec(sandbox, `tail -c 16384 ${ROOT}/${stage}.log`, 5)).output;
    const patterns = { dependency: /ERR_PNPM|Cannot find (?:package|module)|MODULE_NOT_FOUND/, typecheck: /error TS[0-9]+:/,
      disk: /No space left on device/, memory: /out of memory|Killed|oom[-_ ]kill/i, startup: /did not become ready|did not answer|EADDRINUSE|ECONNREFUSED/ };
    const events = Object.entries(patterns).filter(([, pattern]) => pattern.test(tail)).map(([name]) => name);
    const health = stage.startsWith("evidence-world") ? await inspectGuest(api, sandbox).catch(() => undefined) : undefined;
    await diagnostic(stage, JSON.stringify({ stage, events, health: health ?? "unavailable", privateLog: `${ROOT}/${stage}.log` }));
  });
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
  /** Deadline, clock, progress and diagnostic sink shared by the whole preparation. */
  options?: DaytonaBuildOptions;
  /** The build script's stage, whose private log a diagnosis classifies; defaults to `stage`. */
  logStage?: string;
}

export async function ensureLayer(api: DaytonaApi, input: LayerInput): Promise<string> {
  const options = input.options ?? {};
  const budget = buildBudget(options);
  const { clock } = budget;
  const progress = progressReporter(budget, options.progress);
  const start = performance.now();
  const builderName = `ow-dy-build-${digest(input.name).slice(0, 24)}`;
  let waitingOn: { builder?: Sandbox; snapshot?: { name: string; state: string } } = {};
  while (clock.now() < budget.waitUntil) {
    const existing = await api.getSnapshot(input.name);
    if (existing?.state === "active") {
      input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: true });
      return existing.name;
    }
    if (existing && !/error|fail/.test(existing.state)) {
      waitingOn = { snapshot: { name: existing.name, state: existing.state } };
      progress({ stage: input.stage, waiting: "snapshot", snapshot: waitingOn.snapshot });
      await clock.sleep(Math.min(3_000, budget.remaining()));
      continue;
    }
    if (existing) await api.deleteSnapshot(existing.id);
    const owner = await api.getSandbox(builderName);
    if (owner) {
      // Another build of this layer is running; wait for it. A stuck or dead builder is replaced.
      if (owner.labels.kind !== BUILDER_KIND) throw new Error(`Refusing to reuse unrelated sandbox ${builderName}`);
      if (builderIsStale(owner, clock.now())) await api.deleteSandbox(owner.id);
      else {
        waitingOn = { builder: owner };
        progress({ stage: input.stage, waiting: "builder", builder: describeBuilder(owner, clock.now()) });
        await clock.sleep(Math.min(5_000, budget.remaining()));
      }
      continue;
    }
    waitingOn = {};
    const parent = await input.parent();
    if (clock.now() >= budget.waitUntil) break;
    let created: Sandbox;
    try {
      created = await api.createSandbox({ name: builderName, snapshot: parent,
        // The deadline tells other controllers when this one will have given up and deleted the builder.
        labels: { ...input.labels, kind: BUILDER_KIND, layer: digest(input.name).slice(0, 24), deadline: String(budget.deadline) },
        // Polling keeps a live build active; a dead controller's builder stops, then is deleted.
        autoStopMinutes: 30, autoDeleteMinutes: 60 });
    } catch (error) {
      // Lost the race for the builder name; loop to wait for the winner.
      if (error instanceof DaytonaApiError && (error.status === 409 || /already exists/i.test(error.message))) { await clock.sleep(2_000); continue; }
      throw error;
    }
    let diagnosticSandbox = created;
    try {
      const sandbox = await api.waitForSandbox(created.id, ["started"], budget.cap(5 * 60_000));
      diagnosticSandbox = sandbox;
      const prepareStart = performance.now();
      await input.prepare(sandbox);
      input.observe({ stage: `${input.stage}-prepare`, durationMs: Math.round(performance.now() - prepareStart) });
      await api.execChecked(sandbox, "sh -c 'sync && echo 3 > /proc/sys/vm/drop_caches'");
      const snapshotStart = performance.now();
      if (!input.withMemory) {
        await api.stopSandbox(sandbox.id);
        await api.waitForSandbox(sandbox.id, ["stopped"], budget.cap(5 * 60_000));
      }
      await api.snapshotSandbox(sandbox.id, input.name, input.withMemory, { timeoutMs: budget.cap(16 * 60_000),
        now: () => clock.now(), sleep: (ms) => clock.sleep(ms) });
      await waitForSnapshot(api, input.name, budget, input.stage, progress);
      input.observe({ stage: `${input.stage}-snapshot`, durationMs: Math.round(performance.now() - snapshotStart) });
      input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: false });
      return input.name;
    } catch (error) {
      if (input.stage === "daytona-world") await diagnoseGuestFailure(api, diagnosticSandbox, input.stage);
      throw error;
    } finally {
      // Awaited: a failing CI step exits right after, and a builder left running holds the lock.
      await api.deleteSandbox(created.id).catch(() => undefined);
    }
  }
  // Out of budget while another controller held this layer: say on what, before the step is cancelled.
  const message = await describeLayerTimeout(api, input, budget, waitingOn);
  throw new Error(message);
}

/** Waits for a snapshot within the budget, reporting its state while it is saved. */
async function waitForSnapshot(api: DaytonaApi, name: string, budget: BuildBudget, stage: string,
  progress: ReturnType<typeof progressReporter>): Promise<void> {
  await api.waitForSnapshot(name, budget.cap(20 * 60_000),
    (snapshot) => progress({ stage, waiting: "snapshot", snapshot: { name, state: snapshot?.state ?? "missing" } }));
}

/**
 * A bounded account of what this layer waited on when the budget ran out: the
 * builder holding the lock (state, age, its controller's deadline, the commit
 * it builds) and the classified tail of its private log, or the snapshot state.
 */
async function describeLayerTimeout(api: DaytonaApi, input: LayerInput, budget: BuildBudget,
  waitingOn: { builder?: Sandbox; snapshot?: { name: string; state: string } }): Promise<string> {
  const now = budget.clock.now();
  const builder = waitingOn.builder ? describeBuilder(waitingOn.builder, now) : undefined;
  const summary = { stage: input.stage, waitedMs: now - budget.started, budgetMs: budget.deadline - budget.started,
    ...(builder ? { builder } : {}), ...(waitingOn.snapshot ? { snapshot: waitingOn.snapshot } : {}) };
  const diagnostic = input.options?.diagnostic;
  if (diagnostic) {
    await boundedDiagnostic(async () => {
      await diagnostic(`${input.stage}-wait`, JSON.stringify(summary));
      if (waitingOn.builder) await reportBuildFailure(api, waitingOn.builder, input.logStage ?? input.stage, input.options ?? {});
    });
  }
  const on = builder
    ? `builder ${builder.name} (state ${builder.state}, ${builder.ageMs === null ? "age unknown" : `created ${minutes(builder.ageMs)} ago`}${builder.labels.devSha ?? builder.labels.sourceSha ? `, building ${(builder.labels.devSha ?? builder.labels.sourceSha ?? "").slice(0, 9)}` : ""}${builder.ownerDeadlineInMs === null ? "" : `, its controller gives up in ${minutes(builder.ownerDeadlineInMs)}`})`
    : waitingOn.snapshot ? `snapshot ${waitingOn.snapshot.name} (${waitingOn.snapshot.state})` : "the provider";
  return `Daytona ${input.stage} was not ready within this job's ${minutes(budget.deadline - budget.started)} preparation budget; still waiting on ${on}. The other build continues; rerun once it finishes.`;
}

/** Plain Ubuntu at our largest VM size, with Node 24. Built once. */
export async function ensureBase(api: DaytonaApi, options: DaytonaBuildOptions = {}): Promise<string> {
  const observe = options.observe ?? (() => {});
  const plain = `${DAYTONA_BASE_SNAPSHOT}-plain`;
  return ensureLayer(api, { name: DAYTONA_BASE_SNAPSHOT, stage: "daytona-base", observe, withMemory: false, options,
    parent: async () => {
      const existing = await api.getSnapshot(plain);
      const budget = buildBudget(options);
      if (!existing) await api.createImageSnapshot({ name: plain, image: "ubuntu:24.04", ...VM_SIZE },
        { timeoutMs: budget.cap(16 * 60_000), now: () => budget.clock.now(), sleep: (ms) => budget.clock.sleep(ms) });
      await waitForSnapshot(api, plain, budget, "daytona-base", progressReporter(budget, options.progress));
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
    name: `${DAYTONA_IMAGE_PREFIX}${digest(BASE_RECIPE + EVIDENCE_TOOLS_RECIPE + EVIDENCE_DEPENDENCIES_RECIPE + LOCALHOST_RECIPE + dependencyFingerprint(entries))}`,
    stage: "daytona-image", observe: options.observe ?? (() => {}), withMemory: false, labels: { devSha }, options,
    parent: () => ensureBase(api, options),
    prepare: (sandbox) => runScript(api, sandbox, "daytona-image", `${EVIDENCE_TOOLS_RECIPE}\n${checkoutRecipe(devSha)}\n${EVIDENCE_DEPENDENCIES_RECIPE}\n${SLIM_RECIPE}\n${LOCALHOST_RECIPE}\ndf -h /`, options),
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
  const templateName = (fingerprint: string) => `${DAYTONA_TEMPLATE_PREFIX}${digest(BASE_RECIPE + EVIDENCE_TOOLS_RECIPE + EVIDENCE_DEPENDENCIES_RECIPE + LOCALHOST_RECIPE + GATEWAY_UNITS + controller.join("\n") + fingerprint)}`;
  const runtimeFingerprint = evidenceRuntimeFingerprint(entries);
  const state: { mode: "fast" | "full"; restart: string[] } = { mode: "full", restart: [] };
  let allowFast = true;
  const build = () => buildLayer({ name: templateName(runtimeFingerprint), stage: "daytona-world", observe, withMemory: true, labels: { sourceSha: sha },
    options, get logStage() { return state.mode === "fast" ? "evidence-world-fast" : "evidence-world"; },
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
        await runScript(api, sandbox, "evidence-world-fast", `${LOCALHOST_RECIPE}
cd /workspace
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
        await requireLocalEvidenceReady(api, sandbox);
        return;
      }
      for (const [index, name] of EVIDENCE_CONTROLLER_FILES.entries()) await api.writeFile(sandbox, `${ROOT}/${name}`, controller[index]);
      await api.writeFile(sandbox, "/etc/systemd/system/openwork-evidence.service", `[Unit]\nDescription=OpenWork isolated evidence web world\n[Service]\nWorkingDirectory=/workspace\nEnvironment=PATH=${ROOT}/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nExecStart=/usr/bin/env node ${ROOT}/evidence-runtime.mjs\n`);
      await runScript(api, sandbox, "evidence-world", `${LOCALHOST_RECIPE}
${checkoutRecipe(sha)}
${EVIDENCE_DEPENDENCIES_RECIPE}
pnpm --filter @openwork-ee/den-api run build:workspace-dependencies
pnpm --filter openwork-server build
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
      await requireLocalEvidenceReady(api, sandbox);
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
  const built = await buildEvidenceWorld(sha, api, options, (input) => prepareWorldLayer(api, input, sha));
  return { ...built.result, runtimeFingerprint: built.runtimeFingerprint };
}

export async function prepareWorldLayer(api: DaytonaApi, input: LayerInput, sourceSha: string): Promise<{ name: string } | { sandbox: Sandbox }> {
  const start = performance.now();
  const existing = await api.getSnapshot(input.name);
  if (existing?.state === "active") {
    input.observe({ stage: input.stage, durationMs: Math.round(performance.now() - start), cacheHit: true });
    return { name: existing.name };
  }
  // A concurrent warm-up owns its builder and snapshot. Do not wait on, adopt,
  // delete, or change either: this run gets an independent VM from its parent.
  const parent = await input.parent();
  const created = await api.createSandbox({ name: `ow-dy-evidence-${randomUUID().replaceAll("-", "")}`, snapshot: parent,
    labels: { kind: EVIDENCE_KIND, sourceSha }, autoStopMinutes: 30, autoDeleteMinutes: 0 });
  let diagnosticSandbox = created;
  try {
    const sandbox = await api.waitForSandbox(created.id, ["started"], buildBudget(input.options ?? {}).cap(5 * 60_000));
    diagnosticSandbox = sandbox;
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
    await diagnoseGuestFailure(api, diagnosticSandbox, "daytona-world-prepare");
    await api.deleteSandbox(created.id).catch(() => undefined);
    throw error;
  }
}

async function diagnoseGuestFailure(api: DaytonaApi, sandbox: Sandbox, stage: string) {
  await boundedDiagnostic(async () => {
    const health = await inspectGuest(api, sandbox).catch(() => undefined);
    console.error(JSON.stringify({ stage, health: health ?? "unavailable" }));
  });
}
