import { attachSurface } from "@openwork/cdp";
import { trackResource } from "@openwork/world";
import { setTimeout as delay } from "node:timers/promises";
import { checkpointCapability, type CheckpointCapability } from "./checkpoint-capability.ts";
import { cdpRelay } from "./freestyle-evidence.ts";

/** Measured: a checkpoint of the ACME world saves in about 3 minutes. Never wait longer than this. */
const SAVE_WAIT_MS = 10 * 60_000;

/**
 * The web evidence world on a Daytona Linux VM: the same world as Freestyle's,
 * built by @openwork/daytona-evidence. The runner only drives its browser.
 * It advertises checkpoints: each is captured in seconds (a fork of the running
 * VM) and saved in the background; stopping waits for every save.
 */
export async function daytonaEvidenceWeb(sourceSha: string, options: { corePreview?: boolean } = {}) {
  const owner = options.corePreview ? process.env.OPENWORK_DAYTONA_PREVIEW_OWNER : undefined;
  const handoff = owner ? { owner, sourceSha } : undefined;
  // Loaded on demand so worlds that never pick Daytona do not load its client.
  const { ensureEvidenceTemplate, prepareEvidenceWorld } = await import("@openwork/daytona-evidence/builder");
  const { DaytonaApi } = await import("@openwork/daytona-evidence/api");
  const { launchDaytonaEvidenceWorld, deleteDaytonaEvidenceWorld, evidenceControl } = await import("@openwork/daytona-evidence");
  const { startDaytonaCheckpoint } = await import("@openwork/daytona-evidence/checkpoints");
  const { ownPreviewSource, capturePreviewHandoff, validatePreviewOwner } = await import("@openwork/daytona-evidence/handoff");
  if (handoff) validatePreviewOwner(handoff);
  const api = new DaytonaApi();
  const prepare = process.env.OPENWORK_DAYTONA_EPHEMERAL_WORLD === "1" ? prepareEvidenceWorld : ensureEvidenceTemplate;
  const template = await prepare(sourceSha, api, {
    imageSha: process.env.OPENWORK_EVIDENCE_IMAGE_SHA || undefined,
    previewOwner: owner,
    observe: (event) => console.log(JSON.stringify(event)),
    diagnostic: async (stage, log) => {
      console.log(`::group::${stage} builder log (last 80 lines)`);
      console.log(log.split("\n").slice(-80).join("\n"));
      console.log("::endgroup::");
    },
  });
  const session = await launchDaytonaEvidenceWorld(template, sourceSha, api, owner);
  try {
    if (handoff) await ownPreviewSource(session.id, handoff, api);
    await trackResource({ kind: "daytona-evidence", id: session.id, match: session.id, label: "evidence-web" });
    const relay = await cdpRelay(new URL(session.cdp.url), { cookie: session.cookie, "x-daytona-preview-token": session.cdp.previewToken, "x-daytona-skip-preview-warning": "true" });
    let app;
    try { app = await attachSurface({ name: "evidence-web", kind: "chrome", hostKind: "daytona", cdpUrl: relay.url, sandboxId: session.id }); }
    catch (error) { await relay[Symbol.asyncDispose](); throw error; }
    const close = app.stop.bind(app);
    const saves = new Set<Promise<void>>();
    let stopping = false;
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopping = true;
      // The world cannot be deleted while a checkpoint is still being saved from it.
      if (!handoff) {
        const timeout = new AbortController();
        try { await Promise.race([Promise.allSettled([...saves]), delay(SAVE_WAIT_MS, undefined, { signal: timeout.signal })]); }
        finally { timeout.abort(); }
      }
      stopped = true;
      try { await close(); } finally {
        try { await relay[Symbol.asyncDispose](); }
        finally { if (!handoff) await deleteDaytonaEvidenceWorld(session.id, api); }
      }
    };
    const capability: CheckpointCapability = {
      surface: app,
      finalOnly: options.corePreview,
      available: () => !stopping,
      async capture({ imageHash }) {
        if (stopping) throw new Error("The evidence world is stopping");
        if (handoff) return capturePreviewHandoff(session.id, imageHash, handoff, api);
        const started = await startDaytonaCheckpoint({ sandboxId: session.id, sourceSha, imageHash }, api);
        saves.add(started.saved);
        void started.saved.catch(() => undefined).finally(() => saves.delete(started.saved));
        return started;
      },
    };
    app.stop = stop;
    app[Symbol.asyncDispose] = stop;
    return { app, session,
      [checkpointCapability]: capability,
      continueStream: async () => { await evidenceControl(session.id, "continue", api); },
      async streamState() {
        const value: unknown = JSON.parse(await evidenceControl(session.id, "state", api));
        if (typeof value !== "object" || value === null || !("held" in value) || typeof value.held !== "boolean"
          || !("complete" in value) || typeof value.complete !== "boolean" || !("streamCount" in value) || typeof value.streamCount !== "number") throw new Error("Invalid stream witness");
        return { held: value.held, complete: value.complete, streamCount: value.streamCount };
      },
      stop, [Symbol.asyncDispose]: stop,
    };
  } catch (error) { await deleteDaytonaEvidenceWorld(session.id, api); throw error; }
}

/**
 * The one reviewer copy the review app opened for a report since `existingIds`:
 * attaches its restored browser for the test. The caller deletes it with `stop()`.
 */
export async function openedDaytonaCopy(reportId: string, existingIds: readonly string[] = []) {
  const { DaytonaApi } = await import("@openwork/daytona-evidence/api");
  const { listDaytonaCopies, daytonaCopyAccess } = await import("@openwork/daytona-evidence/checkpoints");
  const { evidenceControl } = await import("@openwork/daytona-evidence");
  const api = new DaytonaApi();
  const created = (await listDaytonaCopies(reportId, api)).filter((sandbox) => !existingIds.includes(sandbox.id));
  if (created.length !== 1) throw new Error("Expected one private copy from the review action");
  const copy = await daytonaCopyAccess(created[0].id, api);
  const relay = await cdpRelay(new URL(copy.cdp.url), { cookie: copy.cookie, "x-daytona-preview-token": copy.cdp.previewToken, "x-daytona-skip-preview-warning": "true" });
  let app;
  try { app = await attachSurface({ name: "evidence-copy", kind: "chrome", hostKind: "daytona", cdpUrl: relay.url, sandboxId: copy.id }); }
  catch (error) { await relay[Symbol.asyncDispose](); await api.deleteSandbox(copy.id); throw error; }
  const close = app.stop.bind(app);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { await close(); await relay[Symbol.asyncDispose](); } finally { await api.deleteSandbox(copy.id); }
  };
  app.stop = stop;
  app[Symbol.asyncDispose] = stop;
  return { app, id: copy.id, viewerUrl: copy.viewerUrl, token: copy.token, stop,
    continueStream: async () => { await evidenceControl(copy.id, "continue", api); },
    async streamState(): Promise<unknown> { return JSON.parse(await evidenceControl(copy.id, "state", api)); },
  };
}
