import type { DeploymentCapabilities } from "@openwork/types/den/deployment-capabilities";
import { SERVICE_LABELS, type OrganizationServiceReadiness } from "@openwork/types/den/service-readiness";

export function formatServiceTime(value: string | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not yet";
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date)} UTC`;
}

type OrganizationService = OrganizationServiceReadiness["services"][number];
export type WorkbotDeploymentNotice = {
  message: string;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  stale: boolean;
};

/**
 * Only a real negative fact warns members. Checks run when an operator opens
 * Diagnostics and go stale after a minute, so "not checked yet" and "passed,
 * but a while ago" are normal and must not look like an outage.
 */
function needsAttention(service: OrganizationService): boolean {
  return service.state !== "ready" && service.reason !== "not_checked";
}

/** Advisory only: readiness never grants access or disables model settings or conversations. */
export function workbotDeploymentNotice(capabilities: DeploymentCapabilities | undefined): WorkbotDeploymentNotice | null {
  const readiness = capabilities?.serviceReadiness;
  if (!readiness) return null;
  const relevant = readiness.services.filter((service) => service.id === "headlessRunner" || service.id === "workbot");
  const service = relevant.find((entry) => !entry.configured || entry.state === "misconfigured") ?? relevant.find(needsAttention);
  if (!service) return null;
  const label = SERVICE_LABELS[service.id];
  let message: string;
  if (!service.configured || service.state === "not_configured") {
    message = `${label} isn't set up for this deployment. Ask the deployment administrator to finish setup.`;
  } else if (service.state === "misconfigured") {
    message = `${label} needs a configuration change. Ask the deployment administrator to check its settings.`;
  } else {
    message = `Couldn't verify ${service.id === "workbot" ? "Workbot" : "the headless runner"}. Ask the deployment administrator to check service health, then try again.`;
  }
  // Say what still works only where it isn't obvious: a service that was never set up had nothing to keep.
  if (service.id === "workbot" && !service.configured) message += " Model settings for Slack and Automations are still available.";
  else if (service.configured && service.state !== "misconfigured") message += " Existing conversations and model settings are kept.";
  return { message, checkedAt: service.checkedAt, lastSuccessAt: service.lastSuccessAt, stale: service.stale };
}

/** One quiet line of check history, or nothing when there is no history to report. */
export function serviceCheckLine(notice: Pick<WorkbotDeploymentNotice, "checkedAt" | "lastSuccessAt" | "stale">): string | null {
  if (!notice.checkedAt || formatServiceTime(notice.checkedAt) === "Not yet") return null;
  const checked = `${notice.stale ? "Out of date. " : ""}Last checked ${formatServiceTime(notice.checkedAt)}.`;
  if (!notice.lastSuccessAt) return `${checked} It hasn't passed yet.`;
  if (notice.lastSuccessAt === notice.checkedAt) return checked;
  return `${checked} Last worked ${formatServiceTime(notice.lastSuccessAt)}.`;
}
