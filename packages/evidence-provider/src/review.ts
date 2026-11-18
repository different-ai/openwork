import type { EvidenceCheckpoint } from "./checkpoint.ts";
import { EVIDENCE_PROVIDER_LABELS, EvidenceProviderNotReady, type EvidenceProviderId } from "./provider.ts";

/** What a reviewer can launch from a report. */
export type PreviewWorld = "app-web" | "acme-web" | "desktop" | "workbot";
export function previewWorld(value: unknown): PreviewWorld {
  if (value === "app-web" || value === "acme-web" || value === "desktop" || value === "workbot") return value;
  throw new Error("Unsupported preview world.");
}

export interface PreviewOutput {
  value: string;
  secret?: boolean;
  group?: string;
  note?: string;
}
export type PreviewOutputs = Record<string, PreviewOutput>;

/** A live preview a reviewer opened. Never logged: `url` and outputs carry access tokens. */
export interface PreviewSession {
  id: string;
  gitSha: string;
  url: string;
  expiresAt: string;
  world: PreviewWorld;
  outputs: PreviewOutputs;
}

/** A step that finished while a commit's preview was being built, with how long it took. */
export interface BuildStep { id: string; ms: number }
export interface BuildProgress {
  building: boolean;
  /** The layer being prepared right now, when the provider reports layers. */
  layer?: string;
  /** When that layer's build started (ISO time). */
  since?: string;
  steps: BuildStep[];
}

/** The checkpoint no longer exists or does not match its screenshot. */
export class CheckpointUnavailable extends Error {}
/** Too many copies of this checkpoint are open. */
export class CheckpointCapacity extends Error {}

/**
 * Everything the review app needs from a sandbox provider. The app picks the
 * provider from OPENWORK_EVIDENCE_PROVIDER for new previews, and from each
 * checkpoint's recorded provider when opening a checkpoint.
 */
export interface ReviewPreviewProvider {
  readonly id: EvidenceProviderId;
  readonly label: string;
  /** The review server has this provider's credentials. */
  configured(): boolean;
  /** Can launch fresh previews of a commit (not only open saved checkpoints). */
  readonly supportsPreviews: boolean;
  /** This commit already has a launchable preview for the world. */
  hasSnapshot(gitSha: string, world: PreviewWorld): Promise<boolean>;
  /** Builds the commit's preview. Runs after the response; may take minutes. */
  buildSnapshot(gitSha: string, world: PreviewWorld): Promise<unknown>;
  buildProgress(gitSha: string, world: PreviewWorld): Promise<BuildProgress>;
  launchPreview(input: { gitSha: string; reportId: string; world: PreviewWorld }): Promise<PreviewSession>;
  /**
   * Opens a separate working copy of a saved checkpoint. A retry with the same
   * requestId returns the same copy. Throws CheckpointUnavailable or CheckpointCapacity.
   */
  openCheckpoint(input: { checkpoint: EvidenceCheckpoint; reportId: string; requestId: string }): Promise<{ url: string; expiresAt: string }>;
  /** Log-safe details of a failed launch. Never provider responses, environment or access links. */
  launchFailureDetails(error: unknown): Record<string, string | undefined>;
}

/** A provider that can be selected but has no review support yet. It reports itself as not configured. */
export function notReadyReviewProvider(id: EvidenceProviderId): ReviewPreviewProvider {
  const fail = (): never => { throw new EvidenceProviderNotReady(id, "reviewer previews"); };
  return {
    id,
    label: EVIDENCE_PROVIDER_LABELS[id],
    configured: () => false,
    supportsPreviews: false,
    hasSnapshot: async () => fail(),
    buildSnapshot: async () => fail(),
    buildProgress: async () => fail(),
    launchPreview: async () => fail(),
    openCheckpoint: async () => fail(),
    launchFailureDetails: () => ({}),
  };
}
