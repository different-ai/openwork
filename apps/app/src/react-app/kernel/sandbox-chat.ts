import type { OpenworkSandboxSettingsResponse, OpenworkSandboxStatusResponse } from "@/app/lib/openwork-server";
import { t } from "@/i18n";

export function sandboxEffectiveMode(settings: OpenworkSandboxSettingsResponse | null | undefined) {
  return settings?.effectiveForceSandbox ? "force" : settings?.effectiveUseSandbox ? "use" : "off";
}

export function sandboxCurrentStepText(status: OpenworkSandboxStatusResponse) {
  switch (status.steps.find((step) => step.state === "active")?.id) {
    case "download": return status.imageSource === "bundled" ? t("sandbox.preparing") : t("sandbox.downloading");
    case "folders": return t("sandbox.connecting_folders");
    default: return t("sandbox.starting_tool");
  }
}

export function sandboxPillView(
  settings: OpenworkSandboxSettingsResponse | null | undefined,
  status: OpenworkSandboxStatusResponse | null | undefined,
) {
  const mode = sandboxEffectiveMode(settings);
  if (mode === "off") return null;
  const label = mode === "force" ? t("sandbox.only") : t("sandbox.tag");
  const step = status?.state === "preparing" ? sandboxCurrentStepText(status) : null;
  const attention = status?.state === "failed" || status?.state === "unsupported";
  return { label, step, attention };
}
