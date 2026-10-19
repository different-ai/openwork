import { managedDeploymentReadinessMessage, type ManagedDeployment } from "@openwork/types/den/managed-deployments";

export type DeploymentTone = "neutral" | "warning" | "danger";
export type ProviderReadiness = {
  provider: "aws" | "gcp" | "azure";
  available: boolean;
  reason?: "ready" | "not_configured" | "invalid_configuration" | "not_supported" | "feature_disabled";
  missingFields?: string[];
};

export function providerName(provider: ProviderReadiness["provider"]) {
  return provider === "aws" ? "AWS" : provider === "gcp" ? "Google Cloud" : "Azure";
}

/** Configuration values and secrets never belong in readiness copy. */
export const readinessMessage = managedDeploymentReadinessMessage;

/** A configuration/rollout lock is a blocked state, not a failed cloud installation. */
export class DeploymentReadinessError extends Error {}

/** Race-safe fallback when a rollout or release changes after the form was opened. */
export function deploymentActionError(payload: unknown, provider: ProviderReadiness["provider"]): string | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const reason = payload.error === "feature_disabled" ? "feature_disabled"
    : payload.error === "release_not_configured" ? "not_configured" : null;
  if (!reason) return null;
  if ("message" in payload && typeof payload.message === "string" && payload.message.trim() && payload.message !== payload.error) return payload.message;
  return readinessMessage({ provider, available: false, reason });
}

export type DeploymentReadGate = "pending" | "verified" | "feature_locked" | "access_denied" | "unavailable";
export type DeploymentReadResponse = { status: number; payload: unknown };
export const deploymentPreparationLockMessage = "Deployment preparation is turned off for this workspace. Ask an OpenWork operator to enable deployments. Existing installations are not stopped by this lock.";

/** Only the parent route guard is evidence of this rollout lock. */
export function parentDeploymentsRefused({ status, payload }: DeploymentReadResponse): boolean {
  return status === 404 && typeof payload === "object" && payload !== null
    && "error" in payload && payload.error === "feature_disabled"
    && "feature" in payload && payload.feature === "managedDeployments";
}

/** A partial/failed read cannot lift a known lock or restore content after an access denial. */
export function deploymentReadGateAfterFailure(current: DeploymentReadGate, responses: DeploymentReadResponse[]): DeploymentReadGate {
  const denied = responses.some(({ status, payload }) => status === 401 || status === 403
    || (status === 404 && typeof payload === "object" && payload !== null && "error" in payload
      && (payload.error === "organization_not_found" || payload.error === "org_not_found" || payload.error === "membership_removed")));
  if (denied || current === "access_denied") return "access_denied";
  if (responses.some(parentDeploymentsRefused)) return "feature_locked";
  return current === "feature_locked" ? current : "unavailable";
}

/** Installation/update failures take precedence over the last known health. */
export function deploymentStatus(deployment: ManagedDeployment): { label: string; tone: DeploymentTone } {
  const run = deployment.run;
  const installed = Boolean(deployment.installedVersion);
  if (run && run.state !== "ready") {
    if (run.expired) return { label: installed ? "Update stopped reporting" : "Installer stopped reporting", tone: "danger" };
    if (run.state === "failed") return { label: installed ? "Update failed" : "Install failed", tone: "danger" };
    if (run.state === "awaiting_approval") return { label: `Awaiting ${deployment.provider === "gcp" ? "Google Cloud" : "AWS"} approval`, tone: "neutral" };
    if (run.state === "provisioning") return { label: run.events.some((event) => event.step === "services_ready" && event.outcome === "succeeded") ? "Services started · checking health" : installed ? "Approved · updating" : "Approved · installing", tone: "neutral" };
  }
  if (!installed && !run) return { label: "Not launched", tone: "neutral" };
  switch (deployment.health.state) {
    case "operational": return { label: "Operational", tone: "neutral" };
    case "degraded": return { label: "Degraded", tone: "warning" };
    case "down": return { label: "Down", tone: "danger" };
    case "not_reporting": return { label: "Not reporting", tone: "warning" };
    case "awaiting_report": return { label: "Waiting for first report", tone: "neutral" };
  }
}
