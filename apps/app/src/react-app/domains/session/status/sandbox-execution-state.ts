import type { OpenworkSandboxSettingsResponse } from "../../../../app/lib/openwork-server";

export type SandboxExecutionIndicatorState = {
  label: "context_panel.sandbox_chat_label" | "context_panel.sandbox_chat_pending" | "context_panel.sandbox_chat_unavailable" | "context_panel.sandbox_preparing";
  detail: string;
  state: "sandbox" | "pending" | "starting" | "unavailable";
};

export function sandboxExecutionIndicatorState(settings: OpenworkSandboxSettingsResponse | null | undefined, enabled: boolean): SandboxExecutionIndicatorState | null {
  if (!enabled || !settings) return null;
  if (settings.effectiveAllowHostExecution) {
    return settings.pending && !settings.allowHostExecution
      ? { label: "context_panel.sandbox_chat_pending", detail: "context_panel.host_execution_pending_host", state: "pending" }
      : null;
  }
  if (!settings.featureEnabled || settings.runtime?.state === "failed" || settings.runtime?.state === "unsupported") {
    return { label: "context_panel.sandbox_chat_unavailable", detail: "context_panel.sandbox_chat_unavailable", state: "unavailable" };
  }
  if (settings.runtime?.state === "starting") {
    return { label: "context_panel.sandbox_preparing", detail: "context_panel.sandbox_preparing", state: "starting" };
  }
  return { label: "context_panel.sandbox_chat_label", detail: settings.pending ? "context_panel.host_execution_pending_sandbox" : "context_panel.sandbox_chat_details", state: "sandbox" };
}
