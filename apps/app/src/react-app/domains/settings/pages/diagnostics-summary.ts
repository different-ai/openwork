import type { OpenworkCloudMcpHealth } from "@/app/lib/openwork-server";
import { cloudMcpDisplaySummary } from "@/react-app/domains/connections/cloud-mcp-reconciler";

export type DiagnosticsSummary = {
  tone: "ready" | "warning" | "neutral" | "error";
  label: string;
  detail: string;
};

/** The one line Settings shows about connected tools; the full health stays in the copied report. */
export function summarizeDiagnostics(input: {
  checking: boolean;
  signedIn: boolean;
  orgSelected: boolean;
  health: OpenworkCloudMcpHealth | null;
}): DiagnosticsSummary {
  // A re-check keeps the last result on screen; only the first check has nothing to show yet.
  if (input.checking && !input.health) {
    return { tone: "neutral", label: "Checking", detail: "Checking your connected tools." };
  }
  if (!input.signedIn) {
    return { tone: "neutral", label: "Signed out", detail: "Sign in to OpenWork Cloud to use connected tools." };
  }
  if (!input.orgSelected) {
    return { tone: "neutral", label: "No organization", detail: "Choose an organization to use connected tools." };
  }
  if (!input.health) {
    return { tone: "neutral", label: "Not checked", detail: "Check whether your connected tools are working." };
  }
  const summary = cloudMcpDisplaySummary({
    signedIn: true,
    orgSelected: true,
    connecting: false,
    health: input.health,
  });
  if (summary.status === "ready") {
    return { tone: "ready", label: "Working", detail: "Your connected tools are ready to use." };
  }
  if (summary.status === "disabled") {
    return { tone: "neutral", label: "Turned off", detail: "Connected tools are turned off for this workspace." };
  }
  return {
    tone: "error",
    label: "Needs attention",
    detail: `${summary.stageLabel}. Copy the report and send it to OpenWork support.`,
  };
}

/** "OpenWork v1.2.3, OpenCode 2.0.0": the versions support asks for first. */
export function diagnosticsVersionLine(input: {
  appVersion: string | null;
  health: OpenworkCloudMcpHealth | null;
}): string | null {
  const parts: string[] = [];
  const reported = input.health?.compatibility?.openwork.app?.version;
  const app = input.appVersion?.trim() || (typeof reported === "string" ? reported.trim() : "");
  if (app) parts.push(`OpenWork ${app.startsWith("v") ? app : `v${app}`}`);
  const engine = input.health?.compatibility?.opencode.actualVersion?.trim();
  if (engine) parts.push(`OpenCode ${engine}`);
  return parts.length > 0 ? parts.join(", ") : null;
}
