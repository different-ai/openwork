import type { EvidenceProviderId } from "./provider.ts";

/**
 * A saved checkpoint as recorded in an evidence report. Portable metadata only:
 * never put viewer URLs or credentials here. `provider` names the provider that
 * holds the snapshot, so a report keeps opening with that provider after the
 * default changes.
 */
export interface EvidenceCheckpoint {
  version: 1;
  provider: CheckpointProvider;
  id: string;
  sourceSha: string;
  imageHash: string;
  capturedAt: string;
  expiresAt: string;
}

/** Providers that can save checkpoints, with the ID format each one writes. */
const CHECKPOINT_IDS = {
  freestyle: /^ow-evidence-v1-[a-f0-9]{32}$/,
  daytona: /^ow-dy-checkpoint-v1-[a-f0-9]{32}$/,
} as const satisfies Partial<Record<EvidenceProviderId, RegExp>>;
export type CheckpointProvider = keyof typeof CHECKPOINT_IDS;
const CHECKPOINT_PROVIDERS: CheckpointProvider[] = ["freestyle", "daytona"];

/** Longest a checkpoint may stay openable. */
const MAX_LIFETIME_MS = 24 * 60 * 60_000;

export function parseEvidenceCheckpoint(value: unknown): EvidenceCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid checkpoint");
  const provider = "provider" in value ? CHECKPOINT_PROVIDERS.find((entry) => entry === value.provider) : undefined;
  if (!("version" in value) || value.version !== 1 || !provider
    || !("id" in value) || typeof value.id !== "string" || !CHECKPOINT_IDS[provider].test(value.id)
    || !("sourceSha" in value) || typeof value.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceSha)
    || !("imageHash" in value) || typeof value.imageHash !== "string" || !/^[a-f0-9]{64}$/.test(value.imageHash)
    || !("capturedAt" in value) || typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))
    || !("expiresAt" in value) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error("Invalid checkpoint fields");
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.capturedAt);
  if (lifetime <= 0 || lifetime > MAX_LIFETIME_MS) throw new Error("Invalid checkpoint lifetime");
  return { version: 1, provider, id: value.id, sourceSha: value.sourceSha, imageHash: value.imageHash,
    capturedAt: value.capturedAt, expiresAt: value.expiresAt };
}
