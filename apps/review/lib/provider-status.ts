import { EVIDENCE_PROVIDER_LABELS, EVIDENCE_PROVIDERS, evidenceProviderFromEnv, type EvidenceProviderId } from "@openwork/evidence-provider";
import { daytonaConfigured, DAYTONA_PREVIEW_WORLDS } from "@openwork/daytona-evidence/credentials";
import { freestyleConfigured } from "@openwork/freestyle/credentials";
import type { PreviewProviderOption } from "./preview-options.ts";

/** Credential presence is checked on the review server, never against a local CLI profile. */
export const PROVIDER_CONFIGURED: Record<EvidenceProviderId, () => boolean> = {
  freestyle: freestyleConfigured,
  daytona: daytonaConfigured,
};

interface StatusDependencies {
  configured: Record<EvidenceProviderId, () => boolean>;
  preferred: () => EvidenceProviderId;
}

/** Both choices are safe to serialize: no keys, tokens or provider responses. */
export async function previewProviderOptions(deps: StatusDependencies = {
  configured: PROVIDER_CONFIGURED,
  preferred: evidenceProviderFromEnv,
}): Promise<PreviewProviderOption[]> {
  // Reviewer/CI infrastructure has no Cloud organization or product rollout.
  // Availability comes only from this review server's provider configuration.
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

/** Checkpoints keep the provider recorded with the screenshot, independently of the preferred fresh-launch provider. */
export function connectedCheckpointProviders(): EvidenceProviderId[] {
  return EVIDENCE_PROVIDERS.filter((id) => PROVIDER_CONFIGURED[id]());
}
