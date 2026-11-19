import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseEvidenceCheckpoint, type EvidenceCheckpoint } from "@openwork/evidence-provider/checkpoint";
import { CheckpointCapacity, CheckpointUnavailable } from "@openwork/evidence-provider/review";
import { DaytonaApi, DaytonaApiError, type Sandbox } from "./api.ts";
import { CAPTURE_KIND, COPY_KIND, EVIDENCE_KIND } from "./kinds.ts";

export { CAPTURE_KIND, COPY_KIND };

/**
 * Checkpoints of a Daytona evidence world, the counterpart of Freestyle's.
 *
 * Capture: fork the running world (a copy with memory, taken in seconds, so the
 * test keeps going), save the fork as a memory snapshot named after the
 * checkpoint, then delete the fork.
 * Open: a reviewer gets their own VM started from that snapshot. Its processes,
 * the signed-in browser tab and a paused response included, continue from there.
 */
export const CHECKPOINT_PREFIX = "ow-dy-checkpoint-v1-";
/** How long a saved checkpoint (a PR preview) can be opened. */
export const CHECKPOINT_TTL_SECONDS = 12 * 3600;
const MAX_CHECKPOINTS = 10;
/** Open copies per checkpoint at once. */
const COPY_SLOTS = 3;
/** A reviewer's copy: access lasts this long; Daytona stops it when idle and then deletes it. */
const COPY_MINUTES = 60;
const IDLE_STOP_MINUTES = 30;
const ROOT = "/opt/openwork-preview";
const MANIFEST = `${ROOT}/checkpoint.json`;

export interface StartedCheckpoint {
  checkpoint: EvidenceCheckpoint;
  /** Resolves once the snapshot is saved and the capture fork is gone. Await it before deleting the world. */
  saved: Promise<void>;
}

function sameCheckpoint(a: EvidenceCheckpoint, b: EvidenceCheckpoint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Starts a checkpoint and returns once the state is captured (the fork exists); saving continues in `saved`. */
export async function startDaytonaCheckpoint(input: { sandboxId: string; sourceSha: string; imageHash: string }, api = new DaytonaApi()): Promise<StartedCheckpoint> {
  const sandbox = await api.getSandbox(input.sandboxId);
  if (!sandbox || ![EVIDENCE_KIND, COPY_KIND].includes(sandbox.labels.kind ?? "") || sandbox.labels.sourceSha !== input.sourceSha) throw new Error("Checkpoint source is not an owned evidence world");
  if ((await api.readFile(sandbox, `${ROOT}/evidence-ready`))?.trim() !== "web-v1") throw new Error("Checkpoint source is not a ready evidence world");
  const countText = await api.readFile(sandbox, `${ROOT}/checkpoint-count`);
  const count = countText === null ? 0 : Number(countText);
  if (!Number.isInteger(count) || count < 0 || count >= MAX_CHECKPOINTS) throw new CheckpointCapacity("This proof has reached its ten-checkpoint limit");
  const now = Date.now();
  const checkpoint = parseEvidenceCheckpoint({ version: 1, provider: "daytona", id: `${CHECKPOINT_PREFIX}${randomUUID().replaceAll("-", "")}`,
    sourceSha: input.sourceSha, imageHash: input.imageHash, capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + CHECKPOINT_TTL_SECONDS * 1000).toISOString() });
  await api.writeFile(sandbox, `${ROOT}/checkpoint-count`, String(count + 1));
  // Written before the fork, so the copy carries the manifest it is verified against.
  await api.writeFile(sandbox, MANIFEST, JSON.stringify(checkpoint), 0o600);
  const fork = await api.forkSandbox(sandbox.id, `ow-dy-capture-${randomUUID().replaceAll("-", "")}`);
  const saved = (async () => {
    try {
      await api.setLabels(fork.id, { kind: CAPTURE_KIND, sourceSha: input.sourceSha, checkpoint: checkpoint.id });
      await api.waitForSandbox(fork.id, ["started"]);
      await api.snapshotSandbox(fork.id, checkpoint.id, true);
      await api.waitForSnapshot(checkpoint.id);
    } finally {
      // The world cannot be deleted while this fork exists.
      await api.deleteSandbox(fork.id).catch(() => undefined);
    }
  })();
  // Mark handled now; callers still observe a failure when they await it.
  saved.catch(() => undefined);
  return { checkpoint, saved };
}

interface CopyAccess {
  sandboxId: string;
  token: string;
  expiresAt: string;
  /** Every signed viewer origin issued for this copy; the gateway accepts browser requests only from these. */
  allowedOrigins: string[];
}
/** Keeps the access file small; older links stop being accepted for browser requests. */
const MAX_ISSUED_ORIGINS = 20;

function parseAccess(text: string | null, sandboxId: string): CopyAccess | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("sandboxId" in value) || value.sandboxId !== sandboxId
      || !("token" in value) || typeof value.token !== "string" || !/^[\w-]{43}$/.test(value.token)
      || !("expiresAt" in value) || typeof value.expiresAt !== "string" || !(Date.parse(value.expiresAt) > Date.now())) return null;
    const allowedOrigins = "allowedOrigins" in value && Array.isArray(value.allowedOrigins)
      ? value.allowedOrigins.filter((origin): origin is string => typeof origin === "string") : [];
    return { sandboxId, token: value.token, expiresAt: value.expiresAt, allowedOrigins };
  } catch { return null; }
}

/**
 * The launch link for a copy: a Daytona signed host (no header needed), then the
 * gateway sets its own cookie. Each call signs a new host, recorded in the copy's
 * access file so the gateway accepts browser requests from it.
 */
async function launchLink(api: DaytonaApi, sandbox: Sandbox, access: CopyAccess): Promise<{ url: string; expiresAt: string }> {
  const seconds = Math.max(60, Math.floor((Date.parse(access.expiresAt) - Date.now()) / 1000));
  const origin = new URL(await api.signedPreviewUrl(sandbox.id, 8080, seconds)).origin;
  access.allowedOrigins = [...access.allowedOrigins.filter((entry) => entry !== origin), origin].slice(-MAX_ISSUED_ORIGINS);
  await api.writeFile(sandbox, `${ROOT}/access.json`, JSON.stringify(access), 0o600);
  return { url: `${origin}/__openwork_launch?token=${access.token}`, expiresAt: access.expiresAt };
}

/**
 * Opens a separate working copy of a saved checkpoint for one reviewer. The caller
 * reads the checkpoint from the stored report, never from the request. A retry
 * with the same requestId returns the same copy.
 */
export async function openDaytonaCheckpoint(value: unknown, reportId: string, requestId: string, api = new DaytonaApi()): Promise<{ url: string; expiresAt: string }> {
  const checkpoint = parseEvidenceCheckpoint(value);
  if (checkpoint.provider !== "daytona") throw new Error("Not a Daytona checkpoint");
  if (!/^[a-f0-9]{32}$/.test(reportId) || !/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("Invalid copy request");
  if (Date.parse(checkpoint.expiresAt) <= Date.now()) throw new CheckpointUnavailable("This checkpoint has expired");
  const snapshot = await api.getSnapshot(checkpoint.id);
  if (snapshot?.state !== "active") throw new CheckpointUnavailable("This checkpoint is no longer available");
  const key = createHash("sha256").update(checkpoint.id).digest("hex").slice(0, 24);
  const labels = { kind: COPY_KIND, sourceSha: checkpoint.sourceSha, reportId, requestId, checkpoint: checkpoint.id };
  for (let slot = 0; slot < COPY_SLOTS; slot++) {
    const name = `ow-dy-copy-${key}-${slot}`;
    const existing = await api.getSandbox(name);
    if (existing) {
      const mine = existing.labels.kind === COPY_KIND && existing.labels.reportId === reportId && existing.labels.requestId === requestId && existing.labels.checkpoint === checkpoint.id;
      if (mine && existing.state === "started") {
        const access = parseAccess(await api.readFile(existing, `${ROOT}/access.json`), existing.id);
        if (access) return launchLink(api, existing, access);
      }
      // A finished or broken copy frees its slot; a live copy for someone else keeps it.
      if (existing.labels.kind === COPY_KIND && !["started", "starting", "creating", "restoring"].includes(existing.state)) await api.deleteSandbox(existing.id);
      else continue;
    }
    let created: Sandbox;
    try {
      created = await api.createSandbox({ name, snapshot: checkpoint.id, labels, autoStopMinutes: IDLE_STOP_MINUTES, autoDeleteMinutes: 0 });
    } catch (error) {
      if (error instanceof DaytonaApiError && (error.status === 409 || /already exists/i.test(error.message))) continue;
      throw error;
    }
    try {
      const sandbox = await api.waitForSandbox(created.id, ["started"]);
      const restoredText = await api.readFile(sandbox, MANIFEST);
      if (!restoredText || !sameCheckpoint(parseEvidenceCheckpoint(JSON.parse(restoredText)), checkpoint)
        || (await api.readFile(sandbox, `${ROOT}/evidence-ready`))?.trim() !== "web-v1") throw new CheckpointUnavailable("Checkpoint does not match its screenshot");
      const access: CopyAccess = { sandboxId: sandbox.id, token: randomBytes(32).toString("base64url"), expiresAt: new Date(Date.now() + COPY_MINUTES * 60_000).toISOString(), allowedOrigins: [] };
      return launchLink(api, sandbox, access);
    } catch (error) { await api.deleteSandbox(created.id).catch(() => undefined); throw error; }
  }
  throw new CheckpointCapacity("Three copies are already open for this checkpoint. Try again after one expires.");
}

/** Reviewer copies opened for one report, newest last. For tests that verify what a reviewer got. */
export async function listDaytonaCopies(reportId: string, api = new DaytonaApi()): Promise<Sandbox[]> {
  return (await api.listSandboxes({ kind: COPY_KIND, reportId }))
    .sort((a, b) => Date.parse(a.createdAt ?? "0") - Date.parse(b.createdAt ?? "0"));
}

/**
 * Test access to a reviewer's copy: its browser's remote-control port (private
 * URL plus the gateway cookie) and a fresh viewer launch link with the same
 * access token as the link the review app showed.
 */
export async function daytonaCopyAccess(id: string, api = new DaytonaApi()) {
  const sandbox = await api.getSandbox(id);
  if (!sandbox || sandbox.labels.kind !== COPY_KIND) throw new Error("Not a Daytona checkpoint copy");
  const access = parseAccess(await api.readFile(sandbox, `${ROOT}/access.json`), sandbox.id);
  if (!access) throw new Error("Copy access is missing or expired");
  const cdp = await api.previewUrl(sandbox.id, 8081);
  const viewer = await launchLink(api, sandbox, access);
  return { id: sandbox.id, token: access.token, cookie: `__Host-openwork-preview=${access.token}`, cdp: { url: cdp.url, previewToken: cdp.token }, viewerUrl: viewer.url };
}
