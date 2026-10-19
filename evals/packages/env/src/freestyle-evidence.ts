import { loopbackRelay } from "@openwork/sandbox-connect";
import { attachSurface } from "@openwork/cdp";
import { trackResource } from "@openwork/world";
import { ensureEvidenceSnapshot } from "@openwork/freestyle/evidence-builder";
import { client, execChecked } from "@openwork/freestyle";
import { setTimeout as delay } from "node:timers/promises";
import { deleteEvidenceVm, launchEvidenceWorld, continueEvidenceStream, startEvidenceCheckpoint } from "@openwork/freestyle/checkpoints";
import type { EvidenceSession } from "@openwork/freestyle/checkpoints";
import { checkpointCapability, type CheckpointCapability } from "./checkpoint-capability.ts";

/** Host-only relay: keeps the provider cookie out of CDP URLs and evidence logs. */
export async function evidenceCdpRelay(session: Pick<EvidenceSession, "cdpOrigin" | "cookie">) {
  const remote = new URL(session.cdpOrigin);
  if (remote.protocol !== "https:" || !/^cdp-[a-f0-9]{32}\.preview\.openwork\.software$/.test(remote.hostname)) throw new Error("Invalid evidence CDP origin");
  return cdpRelay(remote, { cookie: session.cookie });
}

/**
 * Loopback relay to a remote browser's remote-control port. Access headers (the
 * gateway cookie, a provider token) are added here, so they never appear in CDP
 * URLs, surfaces or evidence logs. Shared with every provider via
 * @openwork/sandbox-connect.
 */
export async function cdpRelay(remote: URL, access: Record<string, string>) {
  if (remote.protocol !== "https:") throw new Error("Remote browser control must use HTTPS");
  return loopbackRelay(remote, access);
}

export async function attachEvidenceBrowser(session: EvidenceSession) {
  const relay = await evidenceCdpRelay(session);
  try {
    const surface = await attachSurface({ name: "evidence-web", kind: "chrome", hostKind: "freestyle", cdpUrl: relay.url, sandboxId: session.id });
    const close = surface.stop.bind(surface);
    let stopped = false;
    surface.stop = async () => { if (stopped) return; stopped = true; await close(); await relay[Symbol.asyncDispose](); };
    surface[Symbol.asyncDispose] = surface.stop;
    return surface;
  } catch (error) { await relay[Symbol.asyncDispose](); throw error; }
}

/** Longest measured snapshot save was ~7 minutes; never wait longer than this. */
const SAVE_WAIT_MS = 10 * 60_000;

/** Explicit web-only world; the CI controller still uses its local Blacksmith host. */
export async function freestyleEvidenceWeb(sourceSha: string) {
  const snapshot = await ensureEvidenceSnapshot(sourceSha);
  const session = await launchEvidenceWorld(snapshot, sourceSha);
  try {
    await trackResource({ kind: "freestyle-evidence", id: session.id, match: session.id, label: "evidence-web" });
    const app = await attachEvidenceBrowser(session);
    // Snapshots are captured within seconds but saved for up to minutes; the VM
    // must outlive every save it started.
    const saves = new Set<Promise<void>>();
    let stopping = false;
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopping = true;
      await Promise.race([Promise.allSettled([...saves]), delay(SAVE_WAIT_MS)]);
      try { await app.stop(); } finally { await deleteEvidenceVm(session.id); }
      stopped = true;
    };
    // Starts a checkpoint without waiting for it to be saved; `stop()` waits instead.
    const capability: CheckpointCapability = {
      surface: app,
      available: () => !stopping,
      async capture({ imageHash }) {
        if (stopping) throw new Error("The evidence world is stopping");
        const started = await startEvidenceCheckpoint({ vmId: session.id, sourceSha, imageHash });
        saves.add(started.saved);
        void started.saved.catch(() => undefined).finally(() => saves.delete(started.saved));
        return started;
      },
    };
    return { app, session,
      [checkpointCapability]: capability,
      continueStream: () => continueEvidenceStream(session.id),
      async streamState() {
        const text = await execChecked(client().vms.ref(session.id), "node /opt/openwork-preview/evidence-control.mjs state");
        const value: unknown = JSON.parse(text);
        if (typeof value !== "object" || value === null || !("held" in value) || typeof value.held !== "boolean"
          || !("complete" in value) || typeof value.complete !== "boolean" || !("streamCount" in value) || typeof value.streamCount !== "number") throw new Error("Invalid stream witness");
        return { held: value.held, complete: value.complete, streamCount: value.streamCount };
      },
      stop, [Symbol.asyncDispose]: stop,
    };
  } catch (error) { await deleteEvidenceVm(session.id); throw error; }
}
