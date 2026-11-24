import { EVIDENCE_PROVIDER_LABELS, EVIDENCE_PROVIDERS, evidenceProviderFromEnv, type EvidenceProviderId } from "@openwork/evidence-provider";
import { daytonaConfigured, DAYTONA_PREVIEW_WORLDS } from "@openwork/evidence-daytona/credentials";
import { freestyleConfigured } from "@openwork/world-freestyle/credentials";
import type { PreviewProviderOption } from "./preview-options.ts";

export const PROVIDER_CONFIGURED: Record<EvidenceProviderId, () => boolean> = {
  freestyle: freestyleConfigured,
  daytona: daytonaConfigured,
};

interface StatusDependencies {
  configured: Record<EvidenceProviderId, () => boolean>;
  preferred: () => EvidenceProviderId;
}

export async function previewProviderOptions(deps: StatusDependencies = {
  configured: PROVIDER_CONFIGURED,
  preferred: evidenceProviderFromEnv,
}): Promise<PreviewProviderOption[]> {
  const options: PreviewProviderOption[] = EVIDENCE_PROVIDERS.map((id) => {
    const configured = deps.configured[id]();
    return {
      id, label: EVIDENCE_PROVIDER_LABELS[id],
      connected: configured,
      worlds: id === "freestyle" ? ["app-web", "desktop", "acme-web", "workbot"] : DAYTONA_PREVIEW_WORLDS,
      ...(!configured ? { reason: `${EVIDENCE_PROVIDER_LABELS[id]} is not connected. The review app owner can connect it.` } : {}),
    };
  });
  try {
    const preferred = deps.preferred();
    return options.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  } catch {
    return options.map((option) => ({ ...option, connected: false, reason: "The preview provider is misconfigured. The review app owner can check OPENWORK_EVIDENCE_PROVIDER." }));
  }
}

export function connectedCheckpointProviders(): EvidenceProviderId[] {
  return EVIDENCE_PROVIDERS.filter((id) => PROVIDER_CONFIGURED[id]());
}
