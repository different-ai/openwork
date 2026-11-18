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
import { readAppliedSandboxSettings } from "./sandbox-settings-store.js";
import { loadSandboxImageSdk, prepareSandboxGuestImage } from "./packaged-sandbox-assets.js";
import { localSandboxSupport, sandboxRuntimeFailure, type SandboxRuntimeStatus } from "./sandbox-runtime-status.js";

const OPERATION_TIMEOUT = { timeoutMs: 120_000 };
type Entry = { provider: SandboxProvider; handle: SandboxHandle; fingerprint: string; scope: string; invalidated?: boolean; checkedAt?: number; checking?: Promise<void> };
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
  const states = new Map<string, SandboxRuntimeStatus>();
  const preparations = new Map<string, Promise<void>>();
  const access = deps.access ?? (() => managedDesktopPolicy(config).localSandboxAccess());
  const allowHostExecution = deps.allowHostExecution ?? (async () => (await readAppliedSandboxSettings(config)).allowHostExecution);
  const directories = deps.externalDirectories ?? (async () => runtimeExternalDirectory(await readGlobalRuntimeOpencodeConfig(config)));
  const providerFor = deps.provider ?? (async mounts => {
    const adapter = "@openwork/sandbox-microsandbox";
    const load: () => Promise<typeof import("@openwork/sandbox-microsandbox")> = () => import(adapter);
    const { createMicrosandboxProvider } = await load();
    const image = await prepareSandboxGuestImage(await loadSandboxImageSdk());
    return createMicrosandboxProvider({ image, network: { egress: "none" }, mounts });
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

  async function acquire(directory: string) {
    if (closed) throw new Error("The local sandbox service has closed.");
    const permission = await access();
    if (!permission.enabled) {
      await stop(directory);
      throw new Error("Sandbox tools are disabled or their rollout could not be verified. Nothing ran on the host.");
    }
    const unsupported = deps.provider ? undefined : await localSandboxSupport();
    if (unsupported) { states.set(directory, unsupported); throw new Error(unsupported.message); }
    const mounts = await mountsFor(directory);
    const scope = createHash("sha256").update(`${installScope}\n${permission.scope}`).digest("hex");
    const fingerprint = sandboxMountFingerprint(mounts);
    const key = sandboxName(scope, "tools", workspace(directory).id);
    async function verifyBindings() {
      const live = await access();
      const liveScope = createHash("sha256").update(`${installScope}\n${live.scope}`).digest("hex");
      if (closed || !live.enabled || liveScope !== scope || sandboxMountFingerprint(await mountsFor(directory)) !== fingerprint) {
        throw new Error("Sandbox access changed while starting. Retry with the current app and folder settings. Nothing ran on the host.");
      }
    }
    let entry = entries.get(directory);
    let restarted = false;
    if (entry && (entry.invalidated || entry.fingerprint !== fingerprint || entry.scope !== scope)) {
      entry.invalidated = true;
      await destroy(entry);
      entries.delete(directory);
      entry = undefined;
      restarted = true;
    }
    // A failed guest is replaced on explicit prepare/retry or the next real tool call.
    if (entry) {
      try {
        entry.handle = await entry.provider.inspect(entry.handle);
        if (entry.handle.state === "missing" || entry.handle.state === "error") {
          await destroy(entry);
          entries.delete(directory);
          entry = undefined;
          restarted = true;
        }
      } catch (error) {
        if (sandboxErrorCode(error) !== "not_found") throw error;
        entries.delete(directory);
        entry = undefined;
        restarted = true;
      }
    }
    if (!entry) {
      states.set(directory, { state: "starting", stage: "preparing_files", progress: { completed: 0, total: 2 }, canRetry: false });
      const provider = await providerFor(mounts);
      await verifyBindings();
      states.set(directory, { state: "starting", stage: "starting", progress: { completed: 1, total: 2 }, canRetry: false });
      const spec = {
        idempotencyKey: key, image: provider.currentImage(),
        labels: { "openwork.sandbox.scope": scope, "openwork.sandbox.mounts": fingerprint },
        env: {}, storage: [], exposePorts: [], lifecycle: { autoStopMinutes: 15 },
      };
      // Never adopt a stopped VM with stale mount grants after a server restart.
      const existing = await provider.find({ idempotencyKey: key });
      if (existing) { await destroy({ provider, handle: existing }); restarted = true; }
      const handle = await ensureRunning(provider, spec, OPERATION_TIMEOUT);
      entry = { provider, handle, scope, fingerprint };
      entries.set(directory, entry);
    }
    if (entry.handle.state === "stopped") {
      states.set(directory, { state: "starting", stage: "starting", progress: { completed: 1, total: 2 }, canRetry: false });
      await entry.provider.start(entry.handle, OPERATION_TIMEOUT);
    }
    entry.handle = await entry.provider.inspect(entry.handle);
    if (entry.handle.state !== "running") throw new Error("The sandbox did not start.");
    try { await verifyBindings(); }
    catch (error) { entry.invalidated = true; await destroy(entry); throw error; }
    states.set(directory, { state: "ready", canRetry: false });
    return { entry, restarted };
  }
  function recordFailure(directory: string, error: unknown) {
    if (states.get(directory)?.state !== "unsupported") states.set(directory, sandboxRuntimeFailure(error, states.get(directory)?.state === "starting" || !entries.has(directory)));
  }

  const runtime = {
    async status(directory: string): Promise<{ mode: "off" | "tools" | "only" }> {
      // Missing registration is an error, never an invitation to use host builtins.
      directory = workspace(directory).path;
      const localAllows = await allowHostExecution();
      const permission = await access();
      if ((!permission.enabled || closed) && entries.has(directory)) void serial(directory, () => stop(directory)).catch(() => undefined);
      return { mode: !localAllows || permission.hostDenied || permission.hostPolicyVerified === false ? "only" : permission.enabled && !closed ? "tools" : "off" };
    },
    async runtimeStatus(directory: string): Promise<SandboxRuntimeStatus | null> {
      directory = workspace(directory).path;
      const permission = await access();
      if (!permission.enabled || closed) return null;
      const unsupported = deps.provider ? undefined : await localSandboxSupport();
      if (unsupported) return unsupported;
      const state = states.get(directory);
      const current = entries.get(directory);
      if (current && state?.state !== "starting") {
        try {
          const mounts = await mountsFor(directory);
          const scope = createHash("sha256").update(`${installScope}\n${permission.scope}`).digest("hex");
          if (current.invalidated || current.fingerprint !== sandboxMountFingerprint(mounts) || current.scope !== scope) {
            return { state: "idle", message: "Folder access changed. Start the sandbox again to use the current folders.", canRetry: true };
          }
        } catch (error) { recordFailure(directory, error); }
      }
      // Observe without joining the operation queue: setup and long-running tools
      // must remain visible while they run. A status read never wakes a guest.
      const entry = entries.get(directory);
      if (entry && state?.state !== "starting" && !closed) {
        if (!entry.checking && Date.now() - (entry.checkedAt ?? 0) >= 500) {
          const checking = (async () => {
            try {
              const handle = await entry.provider.inspect(entry.handle);
              if (!closed && entries.get(directory) === entry && states.get(directory) === state && handle.state !== "running") {
                states.set(directory, { state: "failed", reason: "stopped", message: "The sandbox stopped. Try again to continue.", canRetry: true });
              }
            } catch (error) {
              if (!closed && entries.get(directory) === entry && states.get(directory) === state) recordFailure(directory, error);
            } finally { entry.checkedAt = Date.now(); }
          })();
          entry.checking = checking;
          void checking.finally(() => { if (entry.checking === checking) entry.checking = undefined; }).catch(() => undefined);
        }
        await entry.checking;
      }
      return states.get(directory) ?? { state: "idle", canRetry: false };
    },
    prepare(directory: string): Promise<void> {
      directory = workspace(directory).path;
      const existing = preparations.get(directory);
      if (existing) return existing;
      const pending = serial(directory, async () => {
        // A retry re-evaluates availability and authority rather than remembering
        // an old unsupported result after the computer or app was repaired.
        states.delete(directory);
        try { await acquire(directory); }
        catch (error) { recordFailure(directory, error); throw error; }
      });
      preparations.set(directory, pending);
      void pending.finally(() => { if (preparations.get(directory) === pending) preparations.delete(directory); }).catch(() => undefined);
      return pending;
    },
    async execute(directory: string, name: string, input: unknown, call?: SandboxToolCall) {
      directory = workspace(directory).path;
      const tool = SANDBOX_TOOL_NAMES.find(tool => tool === name);
      if (!tool) throw new Error("Unknown sandbox tool.");
      sandboxToolSchemas[tool].parse(input);
      return serial(directory, async () => {
        let acquired: Awaited<ReturnType<typeof acquire>>;
        try {
          states.delete(directory);
          acquired = await acquire(directory);
        } catch (error) { recordFailure(directory, error); throw error; }
        const { entry: active, restarted } = acquired;
        const host = createSandboxToolHost({ provider: active.provider, acquire: async () => active.handle, cwd: directory });
        try {
          const result = await host.execute(name, input, call);
          return restarted ? { ...result, metadata: { ...result.metadata, sandboxRestarted: true, notice: "Sandbox recreated with current Authorized Folders. Its guest scratch disk was reset; live host mounts were retained." } } : result;
        } catch (error) {
          // An unsuccessful file operation is not evidence that the guest died.
          // Preserve the tool's error and separately observe runtime health.
          try {
            const handle = await active.provider.inspect(active.handle);
            if (!closed && entries.get(directory) === active && !active.invalidated) {
              active.handle = handle;
              active.checkedAt = Date.now();
              if (handle.state === "running") states.set(directory, { state: "ready", canRetry: false });
              else recordFailure(directory, error);
            }
          } catch (healthError) {
            if (!closed && entries.get(directory) === active) recordFailure(directory, healthError);
          }
          throw error;
        }
      });
    },
    async close() {
      closed = true;
      unsubscribe();
      await Promise.all([...queues.values()].map(pending => pending.catch(() => undefined)));
      try { await Promise.all([...entries.keys()].map(directory => stop(directory))); }
      finally { if (runtimes.get(config) === runtime) runtimes.delete(config); }
    },
  };
  return runtime;
}

// Settings and engine tools must observe and prepare the very same guest.
const runtimes = new WeakMap<ServerConfig, ReturnType<typeof createLocalSandboxRuntime>>();
export function localSandboxRuntime(config: ServerConfig, deps?: LocalSandboxRuntimeDeps) {
  const existing = runtimes.get(config);
  if (existing) return existing;
  const runtime = createLocalSandboxRuntime(config, deps);
  runtimes.set(config, runtime);
  return runtime;
}
export async function closeLocalSandboxRuntime(config: ServerConfig) {
  await runtimes.get(config)?.close();
}
