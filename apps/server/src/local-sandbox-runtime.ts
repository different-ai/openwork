import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ensureRunning, sandboxName, sandboxErrorCode, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox";
import type { MicrosandboxMount } from "@openwork/sandbox-microsandbox";
import type { ServerConfig } from "./types.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { runtimeDbPath, runtimeStorageDir } from "./runtime-db.js";
import { isEngineGlobalRuntimeConfigId, onRuntimeOpencodeConfigWrite, readGlobalRuntimeOpencodeConfig, runtimeExternalDirectory } from "./runtime-opencode-config-store.js";
import { resolveSandboxMounts, sandboxMountFingerprint, sandboxMountGrants } from "./sandbox-mounts.js";
import { createSandboxToolHost, SANDBOX_TOOL_NAMES, sandboxToolSchemas, type SandboxToolCall } from "./sandbox-tool-host.js";
import { readSandboxSettings } from "./sandbox-settings-store.js";

const OPERATION_TIMEOUT = { timeoutMs: 120_000 };
const IMAGE = "alpine:3.22";
type Entry = { provider: SandboxProvider; handle: SandboxHandle; fingerprint: string; scope: string; invalidated?: boolean };
export type LocalSandboxRuntimeDeps = {
  access?: () => Promise<{ enabled: boolean; scope: string; hostDenied?: boolean; hostPolicyVerified?: boolean }>;
  allowHostExecution?: () => Promise<boolean>;
  externalDirectories?: () => Promise<Record<string, unknown>>;
  provider?: (mounts: readonly MicrosandboxMount[]) => Promise<SandboxProvider>;
};

/** Guest tools and mandatory-mode authority share the same server-owned preference and verified policy. */
export function createLocalSandboxRuntime(config: ServerConfig, deps: LocalSandboxRuntimeDeps = {}) {
  const entries = new Map<string, Entry>();
  const queues = new Map<string, Promise<unknown>>();
  const access = deps.access ?? (() => managedDesktopPolicy(config).localSandboxAccess());
  const allowHostExecution = deps.allowHostExecution ?? (async () => (await readSandboxSettings(config)).allowHostExecution);
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
  async function destroy(entry: Pick<Entry, "provider" | "handle">) {
    try { await entry.provider.destroy(entry.handle, OPERATION_TIMEOUT); }
    catch (error) { if (sandboxErrorCode(error) !== "not_found") throw error; }
  }
  async function stop(directory: string) {
    const entry = entries.get(directory);
    if (!entry) return;
    if (entry.invalidated) await destroy(entry);
    else await entry.provider.stop(entry.handle, OPERATION_TIMEOUT);
    entries.delete(directory);
  }
  async function mountsFor(directory: string, snapshot?: Record<string, unknown>) {
    const grants = snapshot ?? await directories();
    return resolveSandboxMounts(sandboxMountGrants(directory, grants, config.readOnly), [
      runtimeStorageDir(config), process.env.MSB_HOME || join(homedir(), ".microsandbox"), join(homedir(), ".openwork", "msb"),
    ], grants);
  }
  const unsubscribe = onRuntimeOpencodeConfigWrite((writtenConfig, workspaceId, snapshot) => {
    if (writtenConfig !== config) return;
    for (const directory of entries.keys()) {
      // Capture this write, not the eventual DB state after queued work. An
      // A -> B -> A grant sequence still has to revoke the old A instance.
      const grants = !deps.externalDirectories && isEngineGlobalRuntimeConfigId(workspaceId) ? runtimeExternalDirectory(snapshot) : undefined;
      const observedMounts = mountsFor(directory, grants).catch(() => null);
      void serial(directory, async () => {
        const entry = entries.get(directory);
        if (!entry) return;
        const mounts = await observedMounts;
        if (!entry.invalidated && mounts && sandboxMountFingerprint(mounts) === entry.fingerprint) return;
        // Leave an invalidated tombstone until replacement, including after a
        // failed destroy. Never resume old bindings because grants changed back.
        entry.invalidated = true;
        await destroy(entry);
      }).catch(error => console.warn("[openwork:sandbox] forced mount revocation failed; guest calls remain blocked until destruction succeeds", { code: sandboxErrorCode(error) ?? "unknown" }));
    }
  });

  return {
    async status(directory: string): Promise<{ mode: "off" | "tools" | "only" }> {
      // Missing registration is an error, never an invitation to use host builtins.
      workspace(directory);
      const localAllows = await allowHostExecution();
      const permission = await access();
      if ((!permission.enabled || closed) && entries.has(directory)) void serial(directory, () => stop(directory)).catch(() => undefined);
      return { mode: !localAllows || permission.hostDenied || permission.hostPolicyVerified === false ? "only" : permission.enabled && !closed ? "tools" : "off" };
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
        if (entry && (entry.invalidated || entry.fingerprint !== fingerprint || entry.scope !== scope)) {
          entry.invalidated = true;
          await destroy(entry);
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
            await destroy({ provider, handle: existing });
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
