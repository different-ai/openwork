import type { FeatureKey } from "@openwork/features";
import { requestJson } from "./den-flow";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a feature is on for someone without an organization (signed out):
 * the deployment-wide state from `GET /v1/features`. Unreachable, slow or
 * missing means off. Signed-in screens use orgFeatureEnabled() instead.
 */
export async function fetchDeploymentFeatureEnabled(key: FeatureKey, timeoutMs = 4000): Promise<boolean> {
  try {
    const { response, payload } = await requestJson("/v1/features", { method: "GET" }, timeoutMs);
    if (!response.ok || !isRecord(payload) || !isRecord(payload.features)) return false;
    return payload.features[key] === true;
  } catch {
    return false;
  }
}
