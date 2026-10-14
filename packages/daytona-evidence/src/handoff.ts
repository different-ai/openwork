import { randomUUID } from "node:crypto";
import { parseEvidenceCheckpoint, type EvidenceCheckpoint } from "@openwork/evidence-provider/checkpoint";
import { DaytonaApi, type Sandbox } from "./api.ts";
import { CAPTURE_KIND, EVIDENCE_KIND } from "./kinds.ts";
import { CHECKPOINT_PREFIX, CHECKPOINT_TTL_SECONDS } from "./checkpoints.ts";

const ROOT = "/opt/openwork-preview";
const RECEIPT = `${ROOT}/preview-handoff.json`;
const MANIFEST = `${ROOT}/checkpoint.json`;
export const OWNER_LABEL = "previewOwner";
export interface PreviewOwner { owner: string; sourceSha: string }
interface Receipt extends PreviewOwner { sourceId: string; forkName: string; checkpoint: EvidenceCheckpoint }
export interface FinalizedPreview { checkpoint: EvidenceCheckpoint; ready: boolean }

export function validatePreviewOwner(input: PreviewOwner): void {
  if (!/^\d+-\d+-[a-z0-9-]+$/.test(input.owner) || !/^[a-f0-9]{40}$/.test(input.sourceSha)) throw new Error("Invalid preview owner or source SHA");
}
function owned(source: Sandbox, input: PreviewOwner): boolean {
  return source.labels.kind === EVIDENCE_KIND && source.labels.previewSource === source.name
    && source.labels[OWNER_LABEL] === input.owner && source.labels.sourceSha === input.sourceSha;
}
export async function ownPreviewSource(id: string, input: PreviewOwner, api = new DaytonaApi()): Promise<void> {
  validatePreviewOwner(input);
  const source = await api.getSandbox(id);
  if (!source || source.labels.kind !== EVIDENCE_KIND || source.labels.sourceSha !== input.sourceSha
    || (source.labels[OWNER_LABEL] && source.labels[OWNER_LABEL] !== input.owner)) throw new Error("Not an owned preview source");
  await api.setLabels(id, { ...source.labels, [OWNER_LABEL]: input.owner, previewSource: source.name });
}

/** Durable receipt precedes the fork request, including an ambiguous provider response.
 * No snapshot request or background work is started by the producer.
 */
export async function capturePreviewHandoff(id: string, imageHash: string, input: PreviewOwner, api = new DaytonaApi()): Promise<{ checkpoint: EvidenceCheckpoint; deferred: true }> {
  validatePreviewOwner(input);
  const source = await api.getSandbox(id);
  if (!source || !owned(source, input) || (await api.readFile(source, `${ROOT}/evidence-ready`))?.trim() !== "web-v1") throw new Error("Not a ready owned preview source");
  if (await api.readFile(source, RECEIPT)) throw new Error("Core preview already captured");
  const now = Date.now();
  const checkpoint = parseEvidenceCheckpoint({ version: 1, provider: "daytona", id: `${CHECKPOINT_PREFIX}${randomUUID().replaceAll("-", "")}`,
    sourceSha: input.sourceSha, imageHash, capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + CHECKPOINT_TTL_SECONDS * 1000).toISOString() });
  const receipt: Receipt = { ...input, sourceId: id, forkName: `ow-dy-capture-${checkpoint.id.slice(CHECKPOINT_PREFIX.length)}`, checkpoint };
  await api.writeFile(source, MANIFEST, JSON.stringify(checkpoint), 0o600);
  await api.writeFile(source, RECEIPT, JSON.stringify(receipt), 0o600);
  // Control-plane durability: recovery must work even if the source's toolbox
  // is stopped/unavailable. Receipts contain no access tokens or credentials.
  await api.setLabels(source.id, { ...source.labels, previewReceipt: JSON.stringify(receipt) });
  // The provider owns the captured VM after this call, not a JS promise.
  const fork = await api.forkSandbox(id, receipt.forkName, { retry: false });
  await api.setLabels(fork.id, { kind: CAPTURE_KIND, sourceSha: input.sourceSha, checkpoint: checkpoint.id, [OWNER_LABEL]: input.owner });
  return { checkpoint, deferred: true };
}

function parseReceipt(text: string, source: Sandbox, input: PreviewOwner): Receipt {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("sourceId" in value) || value.sourceId !== source.id
    || !("owner" in value) || value.owner !== input.owner || !("sourceSha" in value) || value.sourceSha !== input.sourceSha
    || !("checkpoint" in value) || !("forkName" in value) || typeof value.forkName !== "string") throw new Error("Preview receipt ownership mismatch");
  const checkpoint = parseEvidenceCheckpoint(value.checkpoint);
  if (checkpoint.provider !== "daytona" || checkpoint.sourceSha !== input.sourceSha
    || value.forkName !== `ow-dy-capture-${checkpoint.id.slice(CHECKPOINT_PREFIX.length)}`) throw new Error("Preview receipt checkpoint mismatch");
  return { ...input, sourceId: source.id, forkName: value.forkName, checkpoint };
}

/** Runs in another process/job after producer exit. Source stays alive until the
 * fork is released. A failed save never becomes a reopenable image annotation.
 * Repeated calls safely resume a provider-accepted snapshot request.
 */
export async function finalizePreviewHandoffs(input: PreviewOwner, api = new DaytonaApi(), options: { cleanupOnly?: boolean; timeoutMs?: number } = {}): Promise<FinalizedPreview[]> {
  validatePreviewOwner(input);
  const results: FinalizedPreview[] = [];
  const errors: unknown[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  for (const source of await api.listSandboxes({ kind: EVIDENCE_KIND, [OWNER_LABEL]: input.owner, sourceSha: input.sourceSha })) {
    // A fork can inherit the source labels if the producer dies before relabelling it.
    if (source.labels.previewSource !== source.name) continue;
    if (!owned(source, input)) throw new Error("Provider returned an unrelated preview source");
    let receipt: Receipt | undefined;
    let fork: Sandbox | null = null;
    let safeToRelease = false;
    try {
      const text = source.labels.previewReceipt;
      if (!text) { await api.deleteSandbox(source.id); await api.waitForSandboxDeleted(source.id); continue; }
      receipt = parseReceipt(text, source, input);
      fork = await api.getSandbox(receipt.forkName);
      if (fork) {
        safeToRelease = fork.labels[OWNER_LABEL] === input.owner && fork.labels.sourceSha === input.sourceSha
          && ((fork.labels.kind === CAPTURE_KIND && fork.labels.checkpoint === receipt.checkpoint.id)
            || (fork.labels.kind === EVIDENCE_KIND && fork.labels.previewSource === source.name
              && fork.labels.previewReceipt === text));
        // Fork labels may not yet have been written when the producer died.
        // Name + the inherited private manifest prove it is this receipt's fork.
        if (!safeToRelease || !options.cleanupOnly) {
          const labelled = safeToRelease;
          const running = await api.waitForSandbox(fork.id, ["started"], Math.max(1, deadline - Date.now())).catch(error => {
            safeToRelease = labelled; // A failed, labelled fork can still be reclaimed.
            throw error;
          });
          safeToRelease = false;
          const manifest = await api.readFile(running, MANIFEST);
          if (!manifest || JSON.stringify(parseEvidenceCheckpoint(JSON.parse(manifest))) !== JSON.stringify(receipt.checkpoint)) throw new Error("Capture manifest mismatch; refusing cleanup");
          safeToRelease = true;
        }
      } else safeToRelease = true;
      let ready = false;
      {
        if (!options.cleanupOnly) {
          const existing = await api.getSnapshot(receipt.checkpoint.id);
          if (!existing && fork && source.labels.previewSaveRequested !== receipt.checkpoint.id) {
            // At-most-once controller submission, even across a finalizer crash.
            // A crash between this marker and POST loses only the optional
            // preview: recovery times out and cleans it, never invents readiness.
            await api.setLabels(source.id, { ...source.labels, previewSaveRequested: receipt.checkpoint.id });
            try { await api.snapshotSandboxOnce(fork.id, receipt.checkpoint.id, true); }
            catch (error) {
              // A lost response may still have created a durable save. Reconcile
              // by its unique name; never submit another snapshot POST.
              if (!(await api.getSnapshot(receipt.checkpoint.id))) throw error;
            }
          }
          if (!existing && !fork) throw new Error("Preview capture is missing");
          await api.waitForSnapshot(receipt.checkpoint.id, Math.max(1, deadline - Date.now()));
          ready = true;
        }
      }
      results.push({ checkpoint: receipt.checkpoint, ready });
    } catch (error) {
      if (receipt) results.push({ checkpoint: receipt.checkpoint, ready: false });
      errors.push(error);
    } finally {
      if (safeToRelease) {
        try {
          // A rejected delete must leave the source in place for recovery.
          if (fork) {
            await api.deleteSandbox(fork.id);
            await api.waitForSandboxDeleted(fork.id);
          }
          await api.deleteSandbox(source.id);
          await api.waitForSandboxDeleted(source.id);
        } catch (error) { errors.push(error); }
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, "Optional preview finalization failed; run-scoped resources may need recovery");
  return results;
}
