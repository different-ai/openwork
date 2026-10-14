import { evidenceProviderFromEnv, type EvidenceProviderId } from "@openwork/evidence-provider";
import { daytonaEvidenceWeb } from "./daytona-evidence.ts";
import { freestyleEvidenceWeb } from "./freestyle-evidence.ts";
import { checkpointCapability } from "./checkpoint-capability.ts";

const CREDENTIALS: Record<EvidenceProviderId, string[]> = {
  freestyle: ["FREESTYLE_API_KEY"],
  daytona: ["DAYTONA_API_KEY"],
};

/** The provider evidence worlds use: OPENWORK_EVIDENCE_PROVIDER, Freestyle when unset. */
export function evidenceWorldProvider(): EvidenceProviderId {
  return evidenceProviderFromEnv();
}

/** Credentials the selected provider needs to run an evidence world, for a spec's `needs.env`. */
export function evidenceWorldCredentials(provider: EvidenceProviderId = evidenceProviderFromEnv()): string[] {
  return CREDENTIALS[provider];
}

/**
 * This commit's web evidence world (app-web signed in to a seeded Acme org with a
 * deterministic model) on the provider chosen by OPENWORK_EVIDENCE_PROVIDER.
 * Unset means Freestyle.
 */
export async function evidenceWeb(sourceSha: string, provider: EvidenceProviderId = evidenceProviderFromEnv(), options: { corePreview?: boolean } = {}) {
  switch (provider) {
    case "freestyle": {
      const world = await freestyleEvidenceWeb(sourceSha);
      world[checkpointCapability].finalOnly = options.corePreview;
      return world;
    }
    case "daytona": return daytonaEvidenceWeb(sourceSha, options);
  }
}
