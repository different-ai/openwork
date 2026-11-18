/**
 * Which sandbox provider runs evidence worlds (CI journeys, checkpoints) and
 * reviewer previews. One setting chooses it everywhere: the
 * OPENWORK_EVIDENCE_PROVIDER repository variable in CI and the same variable in
 * the review app's environment. Unset means Freestyle, today's behavior.
 */
export const EVIDENCE_PROVIDERS = ["freestyle", "daytona"] as const;
export type EvidenceProviderId = (typeof EVIDENCE_PROVIDERS)[number];

export const EVIDENCE_PROVIDER_ENV = "OPENWORK_EVIDENCE_PROVIDER";
export const DEFAULT_EVIDENCE_PROVIDER: EvidenceProviderId = "freestyle";

export const EVIDENCE_PROVIDER_LABELS: Record<EvidenceProviderId, string> = {
  freestyle: "Freestyle",
  daytona: "Daytona",
};

export function isEvidenceProvider(value: unknown): value is EvidenceProviderId {
  return EVIDENCE_PROVIDERS.some((provider) => provider === value);
}

/** Reads the selected provider. Unset or blank means the default; anything unknown is an error, never a silent fallback. */
export function evidenceProviderFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): EvidenceProviderId {
  const raw = env[EVIDENCE_PROVIDER_ENV]?.trim().toLowerCase();
  if (!raw) return DEFAULT_EVIDENCE_PROVIDER;
  if (isEvidenceProvider(raw)) return raw;
  throw new Error(`${EVIDENCE_PROVIDER_ENV} must be one of ${EVIDENCE_PROVIDERS.join(", ")} (got "${raw}").`);
}

/** The selected provider exists but does not implement this part yet. */
export class EvidenceProviderNotReady extends Error {
  readonly provider: EvidenceProviderId;
  constructor(provider: EvidenceProviderId, feature: string) {
    super(`${EVIDENCE_PROVIDER_LABELS[provider]} does not support ${feature} yet. Unset ${EVIDENCE_PROVIDER_ENV} or set it to ${DEFAULT_EVIDENCE_PROVIDER}.`);
    this.name = "EvidenceProviderNotReady";
    this.provider = provider;
  }
}
