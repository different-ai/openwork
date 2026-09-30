import { t } from "@/i18n";

// Titles resolve lazily so they pick up the active locale: module-level t()
// calls would freeze the strings before initLocale() runs.
export const ADVANCED_SETTINGS_SECTIONS = [
  { id: "organization-server", title: () => t("settings.organization_server_title"), keywords: ["den", "control plane", "server url", "reset server"] },
  { id: "runtime", title: () => t("settings.runtime_title"), keywords: ["opencode engine", "openwork server", "connection status"] },
  { id: "agent-access", title: () => t("ui.agent_access_diagnostics"), keywords: ["cloud mcp", "health", "tools", "connections"] },
  { id: "config-sources", title: () => t("ui.opencode_config_sources"), keywords: ["runtime db", "injected config", "project config", "global config"] },
  { id: "experimental-engine", title: () => t("ui.experimental_engine"), keywords: ["engine v2", "chat engine", "preview"] },
  { id: "workspace-run-mode", title: () => t("ui.workspace_run_mode"), keywords: ["approvals", "permissions", "keep going", "feature flag"] },
  { id: "developer", title: () => t("ui.developer"), keywords: ["developer mode", "debug", "deep link"] },
];
