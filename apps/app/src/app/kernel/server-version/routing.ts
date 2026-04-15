import type { ServerContractHint } from "./types";

export type ServerVersionFeature = "system-health" | "system-status" | "workspace-read";

export type ServerVersionRouteDecision = {
  fallback: "legacy" | "none";
  primary: "legacy" | "server-v2";
  reason: string;
};

export function resolveServerVersionRoute(input: {
  contractHint: ServerContractHint;
  feature: ServerVersionFeature;
  rolloutEnabled: boolean;
  targetKind: "local" | "remote";
}): ServerVersionRouteDecision {
  if (!input.rolloutEnabled) {
    return {
      fallback: "none",
      primary: "legacy",
      reason: "rollout_flag_disabled",
    };
  }

  if (input.contractHint === "legacy") {
    return {
      fallback: "none",
      primary: "legacy",
      reason: "legacy_contract_hint",
    };
  }

  if (input.contractHint === "server-v2") {
    return {
      fallback: "legacy",
      primary: "server-v2",
      reason: `${input.feature}_server_v2_contract_hint`,
    };
  }

  if (input.targetKind === "remote") {
    return {
      fallback: "legacy",
      primary: "server-v2",
      reason: `${input.feature}_rollout_remote_probe`,
    };
  }

  return {
    fallback: "legacy",
    primary: "server-v2",
    reason: `${input.feature}_rollout_local_probe`,
  };
}

export function shouldFallbackToLegacy(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /404|not[ -]?found|Failed to fetch|NetworkError|request_failed/i.test(message);
}
