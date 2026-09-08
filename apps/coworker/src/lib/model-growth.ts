import type { LocalProviderFinding, LocalProvidersReadiness } from "./bridge";

export type ChatgptEvidence =
  | { kind: "none" }
  | { kind: "detected" | "connected"; findingId: string };

/** Presence is not entitlement. A separate Codex file cannot identify the active OpenAI connection. */
export function chatgptEvidence(
  findings: readonly LocalProviderFinding[],
  readiness: Pick<LocalProvidersReadiness, "providers">,
): ChatgptEvidence {
  const candidates = findings.filter((finding) => finding.providerId === "openai" && finding.credentialKind === "chatgpt-oauth"
    && ((finding.kind === "codex" && finding.how === "import") || (finding.kind === "opencode" && finding.how === "in-use")));
  const configured = candidates.find((finding) => finding.kind === "opencode");
  // The engine reports stored keys as api, environment keys as env, and its OpenAI sign-in as custom.
  if (configured && readiness.providers.some((provider) => provider.id === "openai" && provider.source === "custom"
    && provider.connected && provider.modelCount > 0)) return { kind: "connected", findingId: configured.id };
  const detected = candidates.find((finding) => finding.kind === "codex") ?? configured;
  return detected ? { kind: "detected", findingId: detected.id } : { kind: "none" };
}

export const MODEL_GROWTH_OFFER_IDS = ["chatgpt-setup", "share-work", "deep-thinker"] as const;
export type ModelGrowthOfferId = typeof MODEL_GROWTH_OFFER_IDS[number];
export type ModelGrowthOffer = {
  id: ModelGrowthOfferId;
  title: string;
  action:
    | { kind: "setup-chatgpt"; label: string; findingId: string }
    | { kind: "explore-teams" | "explore-thinking"; label: string };
};

/** Navigation suggestions only: never choose a model, import a credential, or send work. */
export function modelGrowthOffer(input: {
  findings: readonly LocalProviderFinding[];
  readiness: Pick<LocalProvidersReadiness, "providers">;
  usingFreeModel: boolean;
  dismissedOfferIds?: readonly string[];
}): ModelGrowthOffer | null {
  const evidence = chatgptEvidence(input.findings, input.readiness);
  let offer: ModelGrowthOffer;
  if (evidence.kind === "detected") {
    offer = {
      id: "chatgpt-setup",
      title: "Use the ChatGPT sign-in found on this Mac",
      action: { kind: "setup-chatgpt", label: "Set up ChatGPT", findingId: evidence.findingId },
    };
  } else if (evidence.kind === "connected") {
    offer = {
      id: "share-work",
      title: "Bring your models. Share the way you work.",
      action: { kind: "explore-teams", label: "Explore templates" },
    };
  } else if (input.usingFreeModel) {
    offer = {
      id: "deep-thinker",
      title: "Add a deep thinker when the work calls for it",
      action: { kind: "explore-thinking", label: "Explore models" },
    };
  } else {
    return null;
  }
  return input.dismissedOfferIds?.includes(offer.id) ? null : offer;
}
