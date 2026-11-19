import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { sandboxName, sandboxErrorCode, shellQuote, type SandboxCreateProgress, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox";
import type { MicrosandboxMount } from "@openwork/sandbox-microsandbox";
import type { ServerConfig } from "./types.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { runtimeDbPath, runtimeStorageDir } from "./runtime-db.js";
import { isEngineGlobalRuntimeConfigId, onRuntimeOpencodeConfigWrite, readGlobalRuntimeOpencodeConfig, runtimeExternalDirectory } from "./runtime-opencode-config-store.js";
import { isSandboxHostConfigOverlay, prepareSandboxHostConfigFolders, resolveSandboxMounts, SandboxFolderError, sandboxMountFingerprint, sandboxMountFingerprintForWrite, sandboxMountGrants } from "./sandbox-mounts.js";
import { createSandboxToolHost, SANDBOX_TOOL_NAMES, sandboxToolSchemas, type SandboxToolCall } from "./sandbox-tool-host.js";
import { readAppliedSandboxSettings, readSandboxSettings, type SandboxSettings } from "./sandbox-settings-store.js";
import { loadSandboxImageSdk, packagedSandboxResources, prepareSandboxGuestImage, sandboxImagePin } from "./packaged-sandbox-assets.js";
import { checkSandboxPlatform, sandboxFailure, sandboxPreparationDurations, sandboxPreparationTimeout, sandboxStatus, type SandboxStatusResponse, type SandboxStepId } from "./sandbox-preparation.js";

const OPERATION_TIMEOUT = { timeoutMs: 120_000 };
type Entry = { provider: SandboxProvider; handle: SandboxHandle; fingerprint: string; scope: string; generation: number; invalidated?: boolean };
export type LocalSandboxRuntimeDeps = {
  access?: () => Promise<{ enabled: boolean; scope: string; hostDenied?: boolean; hostPolicyVerified?: boolean; useRequired?: boolean }>;
  settings?: () => Promise<SandboxSettings>;
  prepareTimeoutMs?: number;
  onTiming?: (reason: string, operations: Readonly<Record<string, number>>) => void;
  externalDirectories?: () => Promise<Record<string, unknown>>;
  provider?: (mounts: readonly MicrosandboxMount[]) => Promise<SandboxProvider>;
};

/** Guest tools and mandatory-mode authority share the same server-owned preference and verified policy. */
export function createLocalSandboxRuntime(config: ServerConfig, deps: LocalSandboxRuntimeDeps = {}) {
  const entries = new Map<string, Entry>();
  const mountEpochs = new Map<string, { generation: number; fingerprint?: string }>();
  const createNames = new Map<string, string>();
  let platformChecked = false;
  const queues = new Map<string, Promise<unknown>>();
  const access = deps.access ?? (() => managedDesktopPolicy(config).localSandboxAccess());
  const settings = deps.settings ?? (async () => {
    const [desired, applied] = await Promise.all([readSandboxSettings(config), readAppliedSandboxSettings(config)]);
    return { useSandbox: desired.useSandbox, forceSandbox: applied.forceSandbox };
  });
  const directories = deps.externalDirectories ?? (async () => runtimeExternalDirectory(await readGlobalRuntimeOpencodeConfig(config)));
  const statuses = new Map<string, SandboxStatusResponse>();
  const preparing = new Map<string, Promise<Entry | undefined>>();
  const consumed = new WeakSet<Promise<Entry | undefined>>();
  const folderNotices = new Set<string>();
  const timeoutMs = deps.prepareTimeoutMs ?? 180_000;
  const imageSource = process.versions.electron && !("defaultApp" in process && process.defaultApp === true) ? "bundled" : "download";
  let durations: { cold: number | null; warm: number | null } = { cold: null, warm: null };
  let readDurations: ReturnType<typeof sandboxPreparationDurations.get> | undefined;
  const durationsKey = "__install__";
  const installScope = createHash("sha256").update(runtimeDbPath(config)).digest("hex");
  let closed = false;

  function workspace(directory: string) {
    const found = config.workspaces.find(workspace => resolve(workspace.path) === resolve(directory));
    if (!found) throw new Error("The sandbox can only be used in a project folder opened in OpenWork. Nothing ran on this computer.");
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
    else {
      const observed = await entry.provider.inspect(entry.handle).catch(error => {
        if (sandboxErrorCode(error) === "not_found") return undefined;
        throw error;
      });
      if (observed?.state === "error") await destroy(entry);
      else if (observed && observed.state !== "missing" && observed.state !== "stopped") {
        await entry.provider.stop(entry.handle, OPERATION_TIMEOUT).catch(error => {
          if (sandboxErrorCode(error) !== "not_found") throw error;
        });
      }
    }
    entries.delete(directory);
  }
  function protectedMountPaths() {
    return [runtimeStorageDir(config), process.env.MSB_HOME || join(homedir(), ".microsandbox"), join(homedir(), ".openwork", "msb")];
  }
  async function mountsFor(directory: string) {
    const grants = await directories();
    await prepareSandboxHostConfigFolders(directory, config.readOnly);
    return resolveSandboxMounts(sandboxMountGrants(directory, grants, config.readOnly), protectedMountPaths(), grants);
  }
  function setMode(directory: string, mode: SandboxStatusResponse["mode"]) {
    const previous = statuses.get(directory);
    if (!previous || mode === "off" || previous.mode === "off") statuses.set(directory, sandboxStatus(mode, imageSource));
    else previous.mode = mode;
  }
  function mountEpoch(directory: string) {
    let epoch = mountEpochs.get(directory);
    if (!epoch) { epoch = { generation: 0 }; mountEpochs.set(directory, epoch); }
    return epoch;
  }
  async function admission() {
    const [permission, local] = await Promise.all([access(), settings()]);
    const mode: SandboxStatusResponse["mode"] = closed ? "off"
      : local.forceSandbox || permission.hostDenied || permission.hostPolicyVerified === false ? "force"
      : permission.enabled && (local.useSandbox || permission.useRequired) ? "use" : "off";
    const scope = createHash("sha256").update(`${installScope}\n${permission.scope}`).digest("hex");
    return { mode, scope, enabled: permission.enabled };
  }
  const disabled = () => new Error("Sandbox tools are disabled or OpenWork couldn't verify that they are available. Nothing ran on this computer.");

  async function prepareNow(directory: string, workspaceId: string, reason: string) {
    if (closed) return;
    const previous = statuses.get(directory);
    let mode = previous?.mode ?? "off";
    let status: SandboxStatusResponse | undefined;
    let step: SandboxStepId | undefined;
    let warm = false;
    let activeSince = 0;
    let timedOut = false;
    const elapsed: Partial<Record<SandboxStepId, number>> = {};
    const begin = (next: SandboxStepId) => {
      if (!status || next === step || timedOut) return;
      const now = performance.now();
      if (step) elapsed[step] = Math.round(now - activeSince);
      const index = status.steps.findIndex(item => item.id === next);
      status.steps.forEach((item, i) => { item.state = i < index ? "done" : i === index ? "active" : "waiting"; });
      activeSince = now;
      step = next;
    };
    const publish = () => {
      if (status) return status;
      status = sandboxStatus(mode, imageSource);
      status.state = "preparing";
      status.startedAt = Date.now();
      status.lastPrepareMs = previous?.lastPrepareMs ?? null;
      status.imageBytes = previous?.imageBytes ?? null;
      statuses.set(directory, status);
      return status;
    };
    const fail = (error: unknown) => {
      const current = publish();
      current.error = sandboxFailure(error, step).detail;
      current.state = current.error.retryable ? "failed" : "unsupported";
      console.warn("[openwork:sandbox] preparation failed", { code: current.error.code });
    };
    const operations: Record<string, number> = {};
    const attemptStarted = performance.now();
    const abort = AbortSignal.timeout(timeoutMs);
    const bounded = async <T>(name: string, operation: Promise<T>): Promise<T> => {
      const start = performance.now();
      let onTimeout: (() => void) | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          onTimeout = () => { timedOut = true; reject(sandboxPreparationTimeout()); };
          if (abort.aborted) onTimeout();
          else abort.addEventListener("abort", onTimeout, { once: true });
        })]);
      } finally {
        if (onTimeout) abort.removeEventListener("abort", onTimeout);
        operations[name] = Math.round(performance.now() - start);
      }
    };
    let cleanup: Entry | undefined;
    try {
      const authority = await bounded("authority", admission());
      mode = authority.mode;
      setMode(directory, mode);
      if (closed) return;
      if (mode === "off" && reason !== "tool") { await bounded("stop", stop(directory)); return; }
      if (!authority.enabled) { await bounded("stop", stop(directory)); throw disabled(); }
      if (!deps.provider && !platformChecked) {
        await bounded("platform", checkSandboxPlatform());
        platformChecked = true;
      }
      const epoch = mountEpoch(directory);
      let mounts: MicrosandboxMount[];
      let generation: number;
      do {
        generation = epoch.generation;
        mounts = await bounded("mounts", mountsFor(directory).catch(error => { throw error instanceof SandboxFolderError ? error : new SandboxFolderError(directory, error); }));
      } while (generation !== epoch.generation);
      const fingerprint = sandboxMountFingerprint(mounts);
      epoch.fingerprint = fingerprint;
      const nameKey = `${directory}\n${authority.scope}`;
      const key = createNames.get(nameKey) ?? sandboxName(authority.scope, "tools", workspaceId);
      let entry = entries.get(directory);
      if (entry && (entry.invalidated || entry.scope !== authority.scope || entry.generation !== generation || entry.fingerprint !== fingerprint)) {
        if (entry.generation !== generation || entry.fingerprint !== fingerprint) folderNotices.add(directory);
        publish();
        begin("start");
        entry.invalidated = true;
        await bounded("destroy", destroy(entry));
        entries.delete(directory);
        entry = undefined;
        // A replacement may still need to prepare the image. Start its ordered steps below.
        step = undefined;
      }
      if (entry) {
        cleanup = entry;
        entry.handle = await bounded("inspect", entry.provider.inspect(entry.handle).catch(error => {
          if (sandboxErrorCode(error) === "not_found" && entry) return { ...entry.handle, state: "missing" };
          throw error;
        }));
        if (entry.handle.state === "running" && previous?.state === "ready") return entry;
        if (entry.handle.state === "missing" || entry.handle.state === "error") {
          entry.invalidated = true;
          publish();
          await bounded("destroy", destroy(entry));
          cleanup = undefined;
          entries.delete(directory);
          entry = undefined;
        }
      }
      const current = publish();
      current.folders = mounts.filter(mount => !isSandboxHostConfigOverlay(mount, mounts)).map(mount => ({ path: mount.guestPath, kind: mount.guestPath === directory ? "workspace" : "folder", access: mount.access }));
      readDurations ??= sandboxPreparationDurations.get(config, durationsKey).catch(() => undefined);
      durations = await bounded("durationsRead", readDurations) ?? durations;
      // Read once, then use the updated in-memory durations after later successes.
      readDurations = Promise.resolve(undefined);
      const estimate = (cached: boolean) => { warm = cached; current.estimatedRemainingMs = cached ? durations.warm : durations.cold; };
      if (!entry) {
        begin("download");
        let provider: SandboxProvider;
        if (deps.provider) provider = await bounded("provider", deps.provider(mounts));
        else {
          const sdk = await bounded("sdk", loadSandboxImageSdk());
          const resources = packagedSandboxResources();
          const pin = sandboxImagePin();
          if (!resources) {
            // A cache hit still has to boot; the progress stream supplies the real download counts on misses.
            const cached = await bounded("imageLookup", sdk.Image.get(pin.reference).then(image => image.manifestDigest === pin.manifestDigest, () => false));
            estimate(cached);
            if (cached) begin("start");
          }
          const image = await bounded("image", prepareSandboxGuestImage(sdk, resources, process.arch, (size, cached) => {
            if (timedOut) return;
            current.imageBytes = size;
            const download = current.steps[0];
            download.totalBytes = size;
            if (cached !== undefined) {
              estimate(cached);
              download.completedBytes = size;
              begin("start");
            }
          }));
          const adapter = "@openwork/sandbox-microsandbox";
          const load: () => Promise<typeof import("@openwork/sandbox-microsandbox")> = () => import(adapter);
          const { createMicrosandboxProvider } = await bounded("adapter", load());
          provider = createMicrosandboxProvider({ image, network: { egress: "none" }, mounts });
        }
        const existing = await bounded("find", provider.find({ idempotencyKey: key }));
        if (existing) {
          // Never adopt a replacement or a VM whose previous grants cannot be proven.
          const tombstone = { provider, handle: existing, scope: authority.scope, fingerprint, generation, invalidated: true };
          entries.set(directory, tombstone);
          await bounded("destroyExisting", destroy(tombstone));
          entries.delete(directory);
        }
        const layers = new Map<number, number>();
        const onProgress = (event: SandboxCreateProgress) => {
          if (timedOut) return;
          if (event.kind === "startup") {
            begin("start");
            current.steps[1].completedBytes = event.completedBytes;
            if (event.totalBytes != null) current.steps[1].totalBytes = event.totalBytes;
            else delete current.steps[1].totalBytes;
          } else if (imageSource === "bundled") return;
          else if (event.kind === "complete") begin("start");
          else if (event.kind === "resolved" && event.totalDownloadBytes !== null) {
            current.imageBytes = event.totalDownloadBytes;
            current.steps[0].totalBytes = event.totalDownloadBytes;
          } else if (event.kind === "layerDownloadProgress" || event.kind === "layerDownloadComplete") {
            layers.set(event.layerIndex, event.downloadedBytes);
            current.steps[0].completedBytes = [...layers.values()].reduce((sum, n) => sum + n, 0);
          }
        };
        // Direct create is intentionally strict: a racing creator must not be adopted.
        const creation = provider.create({
          idempotencyKey: key, image: provider.currentImage(),
          labels: { "openwork.sandbox.scope": authority.scope, "openwork.sandbox.mounts": fingerprint },
          env: {}, storage: [], exposePorts: [], lifecycle: { autoStopMinutes: 15 },
        }, { timeoutMs: Math.min(OPERATION_TIMEOUT.timeoutMs, Math.max(1, timeoutMs - Math.round(performance.now() - attemptStarted))), onProgress });
        let handle: SandboxHandle;
        try { handle = await bounded("create", creation); }
        catch (error) {
          if (timedOut || sandboxErrorCode(error) === "timeout") {
            // A create can finish after its deadline. Retire the name and
            // destroy a late result by handle, not the replacement's name.
            createNames.set(nameKey, sandboxName(authority.scope, "tools", randomUUID()));
            void creation.then(handle => destroy({ provider, handle })).catch(() => undefined);
          }
          throw error;
        }
        entry = { provider, handle, scope: authority.scope, fingerprint, generation };
        entries.set(directory, entry);
      } else estimate(true);
      cleanup = entry;
      begin("start");
      if (entry.handle.state === "stopped" || entry.handle.state === "archived") {
        await bounded("start", entry.provider.start(entry.handle, OPERATION_TIMEOUT));
      }
      if (entry.handle.state !== "running") entry.handle = await bounded("inspectReady", entry.provider.inspect(entry.handle));
      if (entry.handle.state !== "running") throw new Error("Sandbox not running");
      begin("folders");
      const probe = await bounded("folderExec", entry.provider.exec(entry.handle, {
        command: mounts.map((mount, i) => `test -d ${shellQuote(mount.guestPath)} || { echo ${i}; exit 1; }`).join("\n"),
        detach: false, timeoutMs: 5_000,
      }));
      if (await bounded("folderExit", probe.exitCode()) !== 0) {
        const index = Number((await bounded("folderLogs", probe.logs())).stdout.trim());
        throw new SandboxFolderError(mounts[index]?.guestPath ?? directory);
      }
      if (reason === "tool" || reason === "prompt" || preparing.has(directory)) {
        const verified = await bounded("finalAuthority", admission());
        if (!verified.enabled || verified.scope !== authority.scope) throw disabled();
        if (verified.mode !== mode) { mode = verified.mode; setMode(directory, mode); }
      }
      elapsed.folders = Math.round(performance.now() - activeSince);
      current.steps.forEach(item => { item.state = "done"; });
      current.state = "ready";
      current.readyAt = Date.now();
      current.lastPrepareMs = current.readyAt - (current.startedAt ?? current.readyAt);
      current.estimatedRemainingMs = null;
      durations = { ...durations, [warm ? "warm" : "cold"]: current.lastPrepareMs };
      void sandboxPreparationDurations.set(config, durationsKey, durations).catch(() => undefined);
      return entry;
    } catch (error) {
      fail(error);
      if (cleanup) {
        cleanup.invalidated = true;
        // Keep the tombstone even on a failed destroy. A later Retry must destroy before dispatch.
        if (!timedOut) await bounded("cleanup", destroy(cleanup)).catch(() => undefined);
      }
      throw error instanceof Error && /Nothing ran on this computer\.$/.test(error.message) ? error : sandboxFailure(error, step);
    } finally {
      deps.onTiming?.(reason, operations);
      if (status) {
        if (step && elapsed[step] === undefined) elapsed[step] = Math.round(performance.now() - activeSince);
        const trigger = ["startup", "workspace-ready", "setting-enabled", "prompt", "tool", "folders-changed", "retry", "live-cold", "live-stopped", "live-app-restart"].includes(reason) ? reason : "requested";
        console.info("[openwork:sandbox] preparation " + JSON.stringify({ reason: trigger, warm, state: status.state, folderCount: status.folders.length, stepMs: elapsed, totalMs: Date.now() - (status.startedAt ?? Date.now()) }));
      }
    }
  }

  function schedule(directory: string, workspaceId: string, reason: string) {
    const existing = preparing.get(directory);
    if (existing) return existing;
    const current = statuses.get(directory);
    if (current && current.mode !== "off" && (current.state === "idle" || current.state === "failed" || current.state === "unsupported")) {
      const next = sandboxStatus(current.mode, imageSource);
      next.state = "preparing";
      next.startedAt = Date.now();
      next.lastPrepareMs = current.lastPrepareMs;
      next.imageBytes = current.imageBytes;
      statuses.set(directory, next);
    }
    const pending = serial(directory, () => prepareNow(directory, workspaceId, reason));
    preparing.set(directory, pending);
    void pending.finally(() => { if (preparing.get(directory) === pending) preparing.delete(directory); }).catch(() => undefined);
    return pending;
  }

  const unsubscribe = onRuntimeOpencodeConfigWrite((writtenConfig, workspaceId, snapshot) => {
    if (writtenConfig !== config || !isEngineGlobalRuntimeConfigId(workspaceId)) return;
    for (const [directory, epoch] of mountEpochs) {
      let fingerprint: string | undefined;
      try { fingerprint = sandboxMountFingerprintForWrite(directory, runtimeExternalDirectory(snapshot), config.readOnly, protectedMountPaths()); }
      catch { /* An unresolvable write invalidates the current mounts too. */ }
      if (fingerprint !== undefined && fingerprint === epoch.fingerprint) continue;
      epoch.generation++;
      epoch.fingerprint = fingerprint;
      folderNotices.add(directory);
      const project = config.workspaces.find(workspace => resolve(workspace.path) === directory);
      if (!project) continue;
      void serial(directory, async () => {
        const entry = entries.get(directory);
        if (entry && entry.generation === epoch.generation && entry.fingerprint === epoch.fingerprint) return;
        await prepareNow(directory, project.id, "folders-changed");
      }).catch(() => undefined);
    }
  });

  return {
    async status(directory: string): Promise<{ mode: "off" | "tools" | "only" }> {
      const [permission, local] = await Promise.all([access(), settings()]);
      if (local.forceSandbox || permission.hostDenied || permission.hostPolicyVerified === false) return { mode: "only" };
      const registered = config.workspaces.some(workspace => resolve(workspace.path) === resolve(directory));
      return { mode: registered && (local.useSandbox || permission.useRequired) && permission.enabled && !closed ? "tools" : "off" };
    },
    async settingsSnapshot(directory: string): Promise<SandboxStatusResponse> {
      if (!deps.access && !deps.settings) {
        const [local, applied] = await Promise.all([readSandboxSettings(config), readAppliedSandboxSettings(config)]);
        const policy = managedDesktopPolicy(config).sandboxSettingsSnapshot(local, applied);
        const mode = policy.effectiveForceSandbox ? "force" : policy.effectiveUseSandbox ? "use" : "off";
        const stored = this.snapshot(directory);
        if (mode === "off" || stored.mode === "off") return sandboxStatus(mode, imageSource);
        return { ...stored, mode };
      }
      return this.snapshot(directory);
    },
    snapshot(directory: string): SandboxStatusResponse {
      directory = resolve(directory);
      if (closed || !config.workspaces.some(project => resolve(project.path) === directory)) return sandboxStatus("off", imageSource);
      const stored = statuses.get(directory);
      if (!stored) return sandboxStatus("off", imageSource);
      const result = structuredClone(stored);
      if (result.startedAt !== null && result.estimatedRemainingMs !== null) {
        result.estimatedRemainingMs = Math.max(0, result.estimatedRemainingMs - (Date.now() - result.startedAt));
      }
      return result;
    },
    setMode(directory: string, mode: SandboxStatusResponse["mode"]) {
      setMode(resolve(directory), mode);
    },
    async refreshMode(directory: string) {
      const { mode } = await admission();
      setMode(resolve(directory), mode);
      return mode;
    },
    async prepare(directory: string, reason = "requested"): Promise<void> {
      directory = resolve(directory);
      const project = config.workspaces.find(project => resolve(project.path) === directory);
      if (!project || closed) return;
      await schedule(directory, project.id, reason).catch(() => undefined);
    },
    async execute(directory: string, name: string, input: unknown, call?: SandboxToolCall) {
      directory = resolve(directory);
      const project = workspace(directory);
      const tool = SANDBOX_TOOL_NAMES.find(tool => tool === name);
      if (!tool) throw new Error("Unknown sandbox tool.");
      sandboxToolSchemas[tool].parse(input);
      if (closed) throw disabled();
      const pending = schedule(directory, project.id, "tool");
      let dispatched = false;
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(sandboxPreparationTimeout()); }, timeoutMs);
      });
      const command = serial(directory, async () => {
        let entry = await pending;
        if (expired) throw sandboxPreparationTimeout();
        // A second command that joined the same preparation may have waited
        // behind hours of work. It cannot trust the first command's inspection.
        if (consumed.has(pending)) entry = await prepareNow(directory, project.id, "tool");
        consumed.add(pending);
        const epoch = mountEpoch(directory);
        while (entry && (entry.generation !== epoch.generation || entry.fingerprint !== epoch.fingerprint)) {
          if (expired) throw sandboxPreparationTimeout();
          entry = await prepareNow(directory, project.id, "tool");
        }
        if (closed || !entry) throw disabled();
        if (expired) throw sandboxPreparationTimeout();
        if (call?.signal?.aborted) throw new Error("The sandbox command was canceled. Nothing ran.");
        clearTimeout(timer);
        dispatched = true;
        const host = createSandboxToolHost({ provider: entry.provider, acquire: async () => entry.handle, cwd: directory });
        const start = performance.now();
        const result = await host.execute(name, input, call);
        deps.onTiming?.("command", { dispatch: Math.round(performance.now() - start) });
        return folderNotices.delete(directory) ? { ...result, metadata: { ...result.metadata, sandboxRestarted: true, notice: "The sandbox restarted to pick up your folder changes. Files in your folders were kept; temporary files inside the sandbox were cleared." } } : result;
      });
      try { return await Promise.race([command, budget]); }
      catch (error) {
        if (dispatched && sandboxErrorCode(error)) throw sandboxFailure(error, "start");
        // The settings page shows why setup failed. A command also needs to say that it did not run anywhere.
        if (!dispatched && error instanceof Error && !/Nothing ran/.test(error.message)) throw new Error(`${error.message} Nothing ran.`, { cause: error });
        throw error;
      } finally { clearTimeout(timer); }
    },
    async close() {
      closed = true;
      unsubscribe();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...queues.values()]).then(() => Promise.allSettled([...entries.keys()].map(directory => stop(directory)))),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}

const runtimes = new WeakMap<ServerConfig, ReturnType<typeof createLocalSandboxRuntime>>();

export function localSandboxRuntime(config: ServerConfig) {
  let runtime = runtimes.get(config);
  if (!runtime) {
    runtime = createLocalSandboxRuntime(config);
    runtimes.set(config, runtime);
  }
  return runtime;
}

export async function closeLocalSandboxRuntime(config: ServerConfig) {
  const runtime = runtimes.get(config);
  if (!runtime) return;
  await runtime.close();
  runtimes.delete(config);
}
