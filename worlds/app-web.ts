export const supportedTargets = ["local/host", "daytona/linux", "freestyle/linux"];

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startLocalRuntime, startRemoteRuntime } from "../evals/packages/env/src/app-web-runtime.ts";
import { deleteSandboxes, provisionWebSandbox } from "../evals/packages/hosts/src/provision.ts";
import { privateSandboxId, privateWebPreview, verifyPrivateWebPreview } from "../evals/packages/hosts/src/private-web-preview.ts";
import { hold } from "../packages/world/src/hold.ts";
import { LEDGER_ENV, readLedger, rewriteLedger, trackResource } from "../packages/world/src/ledger.ts";
import type { WorldOutput } from "../packages/world/src/outputs.ts";
import { receiptName, resolveStage } from "../packages/world/src/stage.ts";
import { appWebEnvironment, parseAppWebOptions } from "./lib/app-web-options.ts";
import type { AppWebWorldOptions } from "./lib/app-web-options.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_PORT = 5178;

async function localSource(): Promise<{ sha: string; dirty: boolean }> {
  const git = promisify(execFile);
  const options = { cwd: REPO_ROOT, timeout: 10_000 };
  const sha = (await git("git", ["rev-parse", "HEAD"], { ...options, encoding: "utf8" })).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid local app-web source receipt.");
  return { sha, dirty: (await git("git", ["status", "--porcelain"], { ...options, encoding: "utf8" })).stdout.trim().length > 0 };
}

async function releaseSandbox(id: string): Promise<void> {
  await deleteSandboxes([id]);
  const path = process.env[LEDGER_ENV];
  if (path) await rewriteLedger(path, (await readLedger(path)).filter((entry) => entry.kind !== "app-web-daytona" || entry.id !== id));
}

const dependencies = {
  local: startLocalRuntime,
  remote: startRemoteRuntime,
  provision: provisionWebSandbox,
  privateId: privateSandboxId,
  preview: privateWebPreview,
  verify: verifyPrivateWebPreview,
  track: trackResource,
  release: releaseSandbox,
  localSource,
};

export async function bootAppWebWorld(
  stack: AsyncDisposableStack,
  options: AppWebWorldOptions,
  env: NodeJS.ProcessEnv = process.env,
  deps: typeof dependencies = dependencies,
): Promise<Record<string, WorldOutput>> {
  const selectedEnv = appWebEnvironment(env);
  const lifetimeMinutes = options.lifetimeMinutes ?? 120;
  if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 10 || lifetimeMinutes > 1430) throw new Error("app-web lifetime must be 10-1430 minutes.");
  if (options.place === "daytona" && selectedEnv.OPENWORK_DEV_DEN_PROXY_TARGET !== undefined
    && selectedEnv.OPENWORK_DEV_DEN_PROXY_TARGET !== "https://app.openworklabs.com") {
    throw new Error("Remote app-web supports only https://app.openworklabs.com as its Den proxy target.");
  }
  const runtimeName = `${receiptName("app-web", resolveStage(env))}-${randomUUID().slice(0, 8)}`;
  if (options.place === "freestyle") {
    if (!options.ref) throw new Error("Freestyle requires a full pushed source SHA.");
    if (Object.keys(selectedEnv).length) throw new Error("Freestyle snapshots use isolated state and do not accept Den proxy overrides.");
    const { ensureSnapshot } = await import("../packages/freestyle/src/builder.ts");
    const { launchPreview, deletePreview } = await import("../packages/freestyle/src/index.ts");
    await ensureSnapshot(options.ref, undefined, (message) => console.error(message));
    const preview = await launchPreview({ gitSha: options.ref, lifetimeMinutes });
    stack.defer(async () => {
      await deletePreview(preview.id);
      const path = env[LEDGER_ENV];
      if (path) await rewriteLedger(path, (await readLedger(path)).filter((entry) => entry.kind !== "freestyle-preview" || entry.id !== preview.id));
    });
    await deps.track({ kind: "freestyle-preview", id: preview.id, match: preview.id, label: runtimeName });
    return { placement: "freestyle", sourceSha: options.ref, sourceKind: "snapshot", snapshotId: preview.snapshotId,
      sandboxId: preview.id, runtimeName, webUrl: { value: preview.url, secret: true }, previewExpires: preview.expiresAt };
  }
  if (options.place === "local") {
    const source = await deps.localSource();
    const runtime = await deps.local(runtimeName, REPO_ROOT, { env: selectedEnv });
    stack.adopt(runtime, async (owned) => {
      await owned.stop();
      await Promise.all([owned.runtimeDirectory, owned.fixtureRoot].map((path) => rm(path, { recursive: true, force: true })));
    });
    return { placement: "local", sourceSha: source.sha, sourceDirty: String(source.dirty), sourceKind: "working-tree", runtimeName,
      webUrl: runtime.webUrl, openworkUrl: runtime.openworkUrl, runtimeDirectory: runtime.runtimeDirectory };
  }
  if (!options.ref || !/^[a-f0-9]{40}$/.test(options.ref)) throw new Error("Daytona app-web requires a full pushed source SHA.");
  let sandboxId: string | undefined;
  const room = await deps.provision({
    ref: options.ref, name: runtimeName, private: true, autoStopMinutes: 0,
    onCreated: async (name) => {
      sandboxId = await deps.privateId(name);
      await deps.track({ kind: "app-web-daytona", id: sandboxId, match: sandboxId, label: runtimeName });
    },
  });
  if (!room.created) throw new Error("app-web refuses borrowed sandboxes.");
  stack.defer(() => deps.release(sandboxId ?? room.sandbox));
  if (!sandboxId || !room.source || room.source.actualSha !== options.ref || room.source.expectedSha !== options.ref) {
    throw new Error("Private app-web sandbox did not return the exact owned source receipt.");
  }
  const previewIssuedAt = Date.now();
  const preview = await deps.preview(sandboxId, WEB_PORT, undefined, (lifetimeMinutes + 10) * 60);
  const runtime = await deps.remote(sandboxId, runtimeName, "/workspace", room.source, {
    env: { ...selectedEnv, OPENWORK_WEB_PORT: String(WEB_PORT), VITE_HOST: "0.0.0.0" },
    browserHostSuffix: preview.browserHostSuffix,
  });
  stack.adopt(runtime, (owned) => owned.stop());
  if (new URL(runtime.webUrl).port !== String(WEB_PORT)) throw new Error("Private app-web preview port does not match its runtime.");
  await deps.verify(preview);
  if (Date.now() - previewIssuedAt >= 10 * 60_000) throw new Error("app-web exceeded its signed-preview startup buffer.");
  return {
    placement: "daytona", sourceKind: "pushed-commit", requestedRef: room.source.requestedRef,
    sourceSha: room.source.actualSha, sourceFingerprint: room.source.preparedFingerprint, sandboxId, runtimeName,
    webUrl: { value: preview.browserOrigin, secret: true }, previewExpiresInSeconds: String((lifetimeMinutes + 10) * 60),
    previewExpires: new Date(previewIssuedAt + (lifetimeMinutes + 10) * 60_000).toISOString(),
    runtimeWebUrl: runtime.webUrl, runtimeOpenworkUrl: runtime.openworkUrl, runtimeDirectory: runtime.runtimeDirectory,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseAppWebOptions(argv, process.env);
  await using stack = new AsyncDisposableStack();
  const outputs = await bootAppWebWorld(stack, options);
  const lifetimeMs = (options.lifetimeMinutes ?? 120) * 60_000;
  outputs.expires = new Date(Date.now() + lifetimeMs).toISOString();
  const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), lifetimeMs);
  try { await hold({ name: "app-web", outputs }); }
  finally { clearTimeout(timer); }
}

if (import.meta.main) await main();
