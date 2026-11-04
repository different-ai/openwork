import { formatAutomationSchedule } from "@openwork/types/automation-schedule";
import type { AutomationRun, AutomationRunEvent } from "@openwork/types/automations";
import { denYourConnectionUrl } from "@/app/lib/den-dashboard-links";

type RunReceiptState = Pick<AutomationRun, "status" | "error" | "attemptCount" | "startedAt">;

type RunNotice = {
  variant: "default" | "destructive";
  title: string;
  message: string;
};

export function automationRunNotice(run: RunReceiptState): RunNotice | null {
  if (!run.error) return null;
  if (run.status === "skipped" && run.error.code === "runner_unavailable") {
    if (run.attemptCount === 0 && run.startedAt == null) {
      return {
        variant: "default",
        title: "Run missed",
        message: `This occurrence never started. ${run.error.message.trim() || "The desktop runner was unavailable."} Keep OpenWork open, signed in, and your computer awake and connected for future runs.`,
      };
    }
    return {
      variant: "destructive",
      title: "Run interrupted",
      message: `An execution attempt or start was recorded for this run. Recorded cause: ${run.error.message}`,
    };
  }
  if (run.error.code === "connection_action_required") {
    return { variant: "destructive", title: "Connection needed", message: run.error.message };
  }
  return {
    variant: "destructive",
    title: run.status === "failed" && run.error.code === "lease_lost" ? "Run interrupted" : run.error.code,
    message: run.error.message,
  };
}

export function runStatusLabel(run: RunReceiptState) {
  const notice = automationRunNotice(run);
  if (notice && ((run.status === "skipped" && run.error?.code === "runner_unavailable")
    || (run.status === "failed" && run.error?.code === "lease_lost")
    || run.error?.code === "connection_action_required")) {
    return notice.title;
  }
  if (run.status === "skipped" && (run.error?.code === "model_access_lost" || run.error?.code === "provider_unavailable")) {
    return "Skipped — model unavailable";
  }
  return run.status === "succeeded" ? "Completed" : run.status.replaceAll("_", " ");
}

/**
 * The fix for a run that could not use a connection: the connection named in
 * the run's warning event, opened on Your Connections in the signed-in Den.
 * The link is built here from the connection id, never taken from the run.
 */
export function automationRunConnectionFix(
  run: Pick<AutomationRun, "error">,
  events: readonly Pick<AutomationRunEvent, "type" | "payload">[],
  denBaseUrl: string,
): { label: string; url: string } | null {
  if (run.error?.code !== "connection_action_required") return null;
  const warning = [...events].reverse().find((event) => event.type === "warning" && event.payload.code === "connection_action_required");
  const { connectionId, connectionName, state } = warning?.payload ?? {};
  if (typeof connectionId !== "string" || typeof connectionName !== "string") return null;
  const url = denYourConnectionUrl(denBaseUrl, connectionId);
  return url ? { label: `${state === "needs_connection" ? "Connect" : "Reconnect"} ${connectionName}`, url } : null;
}

export function formatAutomationTime(value: number | null | undefined) {
  return typeof value === "number" ? new Date(value).toLocaleString() : "—";
}

/** One shared label for every schedule kind; Den web and the agent listing use the same one. */
export { formatAutomationSchedule };
