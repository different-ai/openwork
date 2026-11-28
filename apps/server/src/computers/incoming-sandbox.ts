import { createHash } from "node:crypto";
import { sandboxErrorCode, sandboxName, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox";
import type { MicrosandboxMount } from "@openwork/sandbox-microsandbox";
import type { ComputerSharingSettings } from "@openwork/types/computer-sharing";
import type { ComputerToolCall } from "@openwork/types/den/computers";
import { loadSandboxImageSdk, prepareSandboxGuestImage } from "../packaged-sandbox-assets.js";
import { runtimeDbPath } from "../runtime-db.js";
import { protectedMountPaths, resolveSandboxMounts, sandboxMountFingerprint } from "../sandbox-mounts.js";
import { checkSandboxPlatform, sandboxFailure, type SandboxStepId } from "../sandbox-preparation.js";
import { createSandboxToolHost } from "../sandbox-tool-host.js";
import type { ServerConfig } from "../types.js";

export class IncomingSandboxUnavailable extends Error {}
type Entry = { provider: SandboxProvider; handle: SandboxHandle; fingerprint: string };
const operationTimeout = { timeoutMs: 120_000 };
function mountAccess(access: ComputerSharingSettings["folders"][number]["access"]): MicrosandboxMount["access"] {
  switch (access) {
    case "read": return "ro";
    case "edit": return "rw";
  }
}

export function createIncomingSandbox(config: ServerConfig, deps: {
  admit(): Promise<boolean>;
  provider?: (mounts: readonly MicrosandboxMount[]) => Promise<SandboxProvider>;
}) {
  const scope = createHash("sha256").update(`incoming-computer\n${runtimeDbPath(config)}`).digest("hex");
  const name = sandboxName(scope, "incoming", "computer-sharing");
  let entry: Entry | undefined;
  let active: AbortController | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let destroying: Promise<void> | undefined;
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  }
  async function destroy(current = entry) {
    if (destroying) await destroying;
    if (!current || current !== entry) return;
    const pending = current.provider.destroy(current.handle, { timeoutMs: 10_000 }).catch(error => {
      if (sandboxErrorCode(error) !== "not_found") throw error;
    });
    destroying = pending;
    try { await pending; if (entry === current) entry = undefined; }
    finally { if (destroying === pending) destroying = undefined; }
  }

  async function acquire(folders: ComputerSharingSettings["folders"], signal: AbortSignal) {
    let step: SandboxStepId = "folders";
    try {
      signal.throwIfAborted();
      if (!await deps.admit()) throw new IncomingSandboxUnavailable("This computer isn't allowed to start its sandbox.");
      const mounts = await resolveSandboxMounts(folders.map(({ path, access }) => ({ hostPath: path, guestPath: path, access: mountAccess(access) })), protectedMountPaths(config));
      if (!mounts.length || mounts.some(mount => mount.hostPath !== mount.guestPath)) {
        throw new IncomingSandboxUnavailable("The shared folders changed; choose them again in Settings > Devices.");
      }
      signal.throwIfAborted();
      const fingerprint = sandboxMountFingerprint(mounts);
      step = "start";
      if (entry && entry.fingerprint !== fingerprint) await destroy();
      if (entry) {
        entry.handle = await entry.provider.inspect(entry.handle);
        if (entry.handle.state === "missing" || entry.handle.state === "error") await destroy();
      }
      if (!entry) {
        let provider: SandboxProvider;
        if (deps.provider) provider = await deps.provider(mounts);
        else {
          await checkSandboxPlatform();
          step = "download";
          const image = await prepareSandboxGuestImage(await loadSandboxImageSdk());
          const adapter = "@openwork/sandbox-microsandbox";
          const { createMicrosandboxProvider }: typeof import("@openwork/sandbox-microsandbox") = await import(adapter);
          provider = createMicrosandboxProvider({ image, mounts, network: { egress: "none" } });
        }
        step = "start";
        signal.throwIfAborted();
        const stale = await provider.find({ idempotencyKey: name });
        if (stale) {
          entry = { provider, handle: stale, fingerprint };
          await destroy();
        }
        signal.throwIfAborted();
        const handle = await provider.create({
          idempotencyKey: name, image: provider.currentImage(), labels: { "openwork.sandbox.scope": scope, "openwork.sandbox.mounts": fingerprint },
          env: {}, storage: [], exposePorts: [], lifecycle: { autoStopMinutes: 15 },
        }, operationTimeout);
        entry = { provider, handle, fingerprint };
      }
      signal.throwIfAborted();
      if (entry.handle.state === "stopped" || entry.handle.state === "archived") await entry.provider.start(entry.handle, operationTimeout);
      if (entry.handle.state !== "running") entry.handle = await entry.provider.inspect(entry.handle);
      if (entry.handle.state !== "running") throw new Error("Sandbox did not start");
      return entry;
    } catch (error) {
      await destroy().catch(() => undefined);
      signal.throwIfAborted();
      if (error instanceof IncomingSandboxUnavailable) throw error;
      const failure = sandboxFailure(error, step);
      throw new IncomingSandboxUnavailable(step === "folders" && failure.detail.code === "folders_failed" ? "The sandbox couldn't connect to your shared folders." : failure.message);
    }
  }

  function stop() {
    active?.abort();
    return serialize(() => destroy());
  }
  return {
    run(call: ComputerToolCall, folders: ComputerSharingSettings["folders"], signal: AbortSignal) {
      return serialize(async () => {
        signal.throwIfAborted();
        if (closed) throw new IncomingSandboxUnavailable("This computer is shutting down.");
        const controller = active = new AbortController();
        const session = AbortSignal.any([signal, controller.signal]);
        let dispatched = false;
        const cancel = () => { if (dispatched) void destroy().catch(() => undefined); };
        session.addEventListener("abort", cancel, { once: true });
        try {
          const current = await acquire(folders, session);
          if (!await deps.admit()) throw new IncomingSandboxUnavailable("This computer isn't allowed to start its sandbox.");
          session.throwIfAborted();
          const host = createSandboxToolHost({ provider: current.provider, acquire: async () => current.handle, cwd: folders[0]?.path ?? "/", computerTools: true });
          dispatched = true;
          return await host.execute(call.tool, call.input, { sessionID: "", signal: session });
        } finally {
          session.removeEventListener("abort", cancel);
          if (session.aborted) await destroy().catch(() => undefined);
          active = undefined;
        }
      });
    },
    stop,
    async close() {
      closed = true;
      const cleanup = stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([cleanup, new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); })]); }
      finally { clearTimeout(timer); }
    },
  };
}
