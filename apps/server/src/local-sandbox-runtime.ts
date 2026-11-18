import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ensureRunning, sandboxName, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox";
import type { MicrosandboxMount } from "@openwork/sandbox-microsandbox";
import type { ServerConfig } from "./types.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { runtimeDbPath, runtimeStorageDir } from "./runtime-db.js";
import { onRuntimeOpencodeConfigWrite, readGlobalRuntimeOpencodeConfig, runtimeExternalDirectory } from "./runtime-opencode-config-store.js";
import { resolveSandboxMounts, sandboxMountFingerprint, sandboxMountGrants } from "./sandbox-mounts.js";
import { createSandboxToolHost, SANDBOX_TOOL_NAMES, sandboxToolSchemas, type SandboxToolCall } from "./sandbox-tool-host.js";

const OPERATION_TIMEOUT = { timeoutMs: 120_000 };
const IMAGE = "alpine:3.22";
type Entry = { provider: SandboxProvider; handle: SandboxHandle; fingerprint: string; scope: string };
export type LocalSandboxRuntimeDeps = {
  access?: () => Promise<{ enabled: boolean; scope: string }>;
  externalDirectories?: () => Promise<Record<string, unknown>>;
  provider?: (mounts: readonly MicrosandboxMount[]) => Promise<SandboxProvider>;
};

/** Local tools only. The first slice deliberately has no reachable sandbox-only setting yet. */
export function createLocalSandboxRuntime(config: ServerConfig, deps: LocalSandboxRuntimeDeps = {}) {
  const entries = new Map<string, Entry>();
  const queues = new Map<string, Promise<unknown>>();
  const access = deps.access ?? (() => managedDesktopPolicy(config).localSandboxAccess());
  const directories = deps.externalDirectories ?? (async () => runtimeExternalDirectory(await readGlobalRuntimeOpencodeConfig(config)));
  const providerFor = deps.provider ?? (async mounts => {
    const adapter = "@openwork/sandbox-microsandbox";
    const load: () => Promise<typeof import("@openwork/sandbox-microsandbox")> = () => import(adapter);
    const { createMicrosandboxProvider } = await load();
    return createMicrosandboxProvider({ image: IMAGE, network: { egress: "none" }, mounts });
  });
  const installScope = createHash("sha256").update(runtimeDbPath(config)).digest("hex");
  let closed = false;

  function workspace(directory: string) {
    const found = config.workspaces.find(workspace => resolve(workspace.path) === resolve(directory));
    if (!found) throw new Error("Sandbox tools require a registered local workspace.");
    return found;
  }
  function serial<T>(directory: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(directory) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    queues.set(directory, pending);
    void pending.finally(() => { if (queues.get(directory) === pending) queues.delete(directory); }).catch(() => undefined);
    return pending;
  }
  async function stop(directory: string) {
    const entry = entries.get(directory);
    if (!entry) return;
    await entry.provider.stop(entry.handle, OPERATION_TIMEOUT);
    entries.delete(directory);
  }
  async function mountsFor(directory: string) {
    const grants = await directories();
    return resolveSandboxMounts(sandboxMountGrants(directory, grants, config.readOnly), [
      runtimeStorageDir(config), process.env.MSB_HOME || join(homedir(), ".microsandbox"), join(homedir(), ".openwork", "msb"),
    ], grants);
  }
  const unsubscribe = onRuntimeOpencodeConfigWrite((writtenConfig) => {
    if (writtenConfig !== config) return;
    for (const directory of entries.keys()) void serial(directory, async () => {
      const entry = entries.get(directory);
      if (!entry) return;
      const mounts = await mountsFor(directory).catch(() => null);
      if (mounts && sandboxMountFingerprint(mounts) === entry.fingerprint) return;
      // Keep the old fingerprint so the next call recreates rather than resumes stale grants.
      await entry.provider.stop(entry.handle, OPERATION_TIMEOUT);
    }).catch(() => undefined);
  });

  return {
    async status(directory: string): Promise<{ mode: "off" | "tools" }> {
      if (closed || !config.workspaces.some(workspace => resolve(workspace.path) === resolve(directory))) return { mode: "off" };
      const permission = await access();
      if (!permission.enabled && entries.has(directory)) void serial(directory, () => stop(directory)).catch(() => undefined);
      return { mode: permission.enabled ? "tools" : "off" };
    },
    async execute(directory: string, name: string, input: unknown, call?: SandboxToolCall) {
      workspace(directory);
      const tool = SANDBOX_TOOL_NAMES.find(tool => tool === name);
      if (!tool) throw new Error("Unknown sandbox tool.");
      sandboxToolSchemas[tool].parse(input);
      return serial(directory, async () => {
        if (closed) throw new Error("The local sandbox service has closed.");
        const permission = await access();
        if (!permission.enabled) {
          await stop(directory);
          throw new Error("Sandbox tools are disabled or their rollout could not be verified. Nothing ran on the host.");
        }
        const mounts = await mountsFor(directory);
        const scope = createHash("sha256").update(`${installScope}\n${permission.scope}`).digest("hex");
        const fingerprint = sandboxMountFingerprint(mounts);
        const key = sandboxName(scope, "tools", workspace(directory).id);
        let entry = entries.get(directory);
        let restarted = false;
        if (entry && (entry.fingerprint !== fingerprint || entry.scope !== scope)) {
          await entry.provider.destroy(entry.handle, OPERATION_TIMEOUT);
          entries.delete(directory);
          entry = undefined;
          restarted = true;
        }
        if (!entry) {
          const provider = await providerFor(mounts);
          const spec = {
            idempotencyKey: key, image: provider.currentImage(),
            labels: { "openwork.sandbox.scope": scope, "openwork.sandbox.mounts": fingerprint },
            env: {}, storage: [], exposePorts: [], lifecycle: { autoStopMinutes: 15 },
          };
          // Never adopt a stopped VM with stale mount grants after a server restart.
          const existing = await provider.find({ idempotencyKey: key });
          if (existing) {
            await provider.destroy(existing, OPERATION_TIMEOUT);
            restarted = true;
          }
          const handle = await ensureRunning(provider, spec, OPERATION_TIMEOUT);
          entry = { provider, handle, scope, fingerprint };
          entries.set(directory, entry);
        }
        const active = entry;
        active.handle = await active.provider.inspect(active.handle);
        if (active.handle.state === "stopped") {
          await active.provider.start(active.handle, OPERATION_TIMEOUT);
          active.handle = await active.provider.inspect(active.handle);
        }
        const host = createSandboxToolHost({ provider: active.provider, acquire: async () => active.handle, cwd: directory });
        const result = await host.execute(name, input, call);
        return restarted ? { ...result, metadata: { ...result.metadata, sandboxRestarted: true, notice: "Sandbox recreated with current Authorized Folders. Its guest scratch disk was reset; live host mounts were retained." } } : result;
      });
    },
    async close() {
      closed = true;
      unsubscribe();
      await Promise.all([...queues.values()].map(pending => pending.catch(() => undefined)));
      await Promise.all([...entries.keys()].map(directory => stop(directory)));
    },
  };
}
