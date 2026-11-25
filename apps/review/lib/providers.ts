import { evidenceProviderFromEnv, type EvidenceProviderId } from "@openwork/evidence-provider";
import type { ReviewPreviewProvider } from "@openwork/evidence-provider/review";
import { daytonaReviewProvider } from "@openwork/evidence-daytona/review-provider";
import { freestyleReviewProvider } from "@openwork/world-freestyle/review-provider";

const providers: Record<EvidenceProviderId, ReviewPreviewProvider> = {
  freestyle: freestyleReviewProvider,
  daytona: daytonaReviewProvider,
};

export function reviewProvider(id: EvidenceProviderId): ReviewPreviewProvider {
  return providers[id];
}

export function selectedReviewProvider(id?: EvidenceProviderId): ReviewPreviewProvider {
  return providers[id ?? evidenceProviderFromEnv()];
}
