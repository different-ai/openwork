import { EVIDENCE_PROVIDER_LABELS } from "@openwork/evidence-provider";
import type { ReviewPreviewProvider } from "@openwork/evidence-provider/review";
import { ensureSnapshot } from "./builder.ts";
import { freestyleConfigured } from "./credentials.ts";
import { forkEvidenceCheckpoint } from "./checkpoints.ts";
import { findSnapshot, launchPreview, PreviewLaunchError } from "./index.ts";
import { buildProgress } from "./progress.ts";

/** Reviewer previews and checkpoint copies on Freestyle VMs. */
export const freestyleReviewProvider: ReviewPreviewProvider = {
  id: "freestyle",
  label: EVIDENCE_PROVIDER_LABELS.freestyle,
  configured: freestyleConfigured,
  supportsPreviews: true,
  hasSnapshot: async (gitSha, world) => Boolean(await findSnapshot(gitSha, undefined, world)),
  buildSnapshot: (gitSha, world) => ensureSnapshot(gitSha, undefined, (message) => console.log(message), world, {
    diagnostic: async (stage, log) => console.error("Freestyle preview builder log", { gitSha, world, stage, tail: log.split("\n").slice(-60).join("\n") }),
  }),
  buildProgress: (gitSha, world) => buildProgress(gitSha, world),
  launchPreview: (input) => launchPreview(input),
  async openCheckpoint({ checkpoint, reportId, requestId }) {
    const fork = await forkEvidenceCheckpoint(checkpoint, reportId, requestId);
    return { url: fork.url, expiresAt: fork.expiresAt };
  },
  launchFailureDetails(error) {
    if (!(error instanceof PreviewLaunchError)) return {};
    return { stage: error.stage, vmId: error.vmId,
      reason: error.cause instanceof Error && /^(?:Public sandbox readiness failed \(HTTP |Freestyle guest command failed \()/.test(error.cause.message) ? error.cause.message : undefined };
  },
};
