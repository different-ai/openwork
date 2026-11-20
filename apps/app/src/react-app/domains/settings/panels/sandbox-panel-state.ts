import type { OpenworkSandboxSettingsResponse, OpenworkSandboxStatusResponse, SandboxSettingsUpdate, SandboxStepId } from "@/app/lib/openwork-server";
import { t } from "@/i18n";

export type SandboxSwitchNote = "managed" | "included" | null;
export type SandboxToggle = { setting: "use" | "force"; checked: boolean };

export function sandboxPanelVisibility(
  rollout: boolean | undefined,
  read: "loading" | "error" | "settled",
  settings?: OpenworkSandboxSettingsResponse | null,
) {
  const visible = rollout === true || (read !== "error" && Boolean(settings && (
    settings.useSandbox || settings.forceSandbox || settings.managedUse || settings.managedForce || settings.pending
  )));
  return {
    visible,
    ready: read !== "loading" && (visible || rollout !== undefined),
  };
}

export function sandboxPanelState(settings: OpenworkSandboxSettingsResponse, update?: SandboxSettingsUpdate) {
  const managedForce = settings.managedForce;
  const managedUse = settings.managedUse || managedForce;
  const force = managedForce || (update?.forceSandbox ?? settings.forceSandbox);
  const use = force || managedUse || (update?.useSandbox ?? settings.useSandbox);
  const useNote: SandboxSwitchNote = managedUse ? "managed" : force ? "included" : null;
  const forceNote: SandboxSwitchNote = managedForce ? "managed" : null;
  return {
    use,
    force,
    useNote,
    forceNote,
    unavailable: !settings.featureEnabled && (force || managedUse || (settings.pending && settings.effectiveForceSandbox)),
    pending: settings.pending ? settings.effectiveForceSandbox ? "sandbox" : "computer" : null,
    verification: settings.verification,
  };
}

export function sandboxToggleUpdate(setting: "use" | "force", checked: boolean): SandboxSettingsUpdate {
  if (setting === "use") return checked ? { useSandbox: true } : { useSandbox: false, forceSandbox: false };
  return { forceSandbox: checked };
}

export function sandboxEditableToggleUpdate(settings: OpenworkSandboxSettingsResponse, toggle: SandboxToggle): SandboxSettingsUpdate | null {
  const { useNote, forceNote } = sandboxPanelState(settings);
  if (toggle.setting === "use" ? useNote : forceNote) return null;
  return sandboxToggleUpdate(toggle.setting, toggle.checked);
}

export function sandboxSavedChoiceMatches(settings: OpenworkSandboxSettingsResponse | null, update: SandboxSettingsUpdate): boolean {
  return settings !== null
    && (update.useSandbox === undefined || settings.useSandbox === update.useSandbox)
    && (update.forceSandbox === undefined || settings.forceSandbox === update.forceSandbox);
}

export function sandboxImageSize(bytes: number | null) {
  return bytes !== null && bytes > 0 ? Math.max(1, Math.round(bytes / 1_000_000)) : null;
}

export function sandboxEstimateText(ms: number | null) {
  if (ms === null || ms <= 0) return null;
  const count = Math.ceil(ms / 1000);
  return count === 1 ? t("sandbox.estimate_one") : t("sandbox.estimate", undefined, { count });
}

const STEP_IDS: SandboxStepId[] = ["download", "start", "folders"];

type SandboxStatusView =
  | { kind: "none" }
  | { kind: "ready"; folders: OpenworkSandboxStatusResponse["folders"] }
  | { kind: "failed" | "unsupported"; error: OpenworkSandboxStatusResponse["error"]; retry: boolean }
  | { kind: "progress"; estimate: string | null; steps: { id: SandboxStepId; label: string; state: "waiting" | "active" | "done"; value: number | null }[] };

export function sandboxStatusView(status: OpenworkSandboxStatusResponse | null | undefined, wanted: boolean): SandboxStatusView {
  if (!status || !wanted) return { kind: "none" };
  switch (status.state) {
    case "ready": return { kind: "ready", folders: status.folders };
    case "unsupported":
    case "failed": return { kind: status.state, error: status.error, retry: status.state === "failed" && status.error?.retryable === true };
    case "idle":
    case "preparing": {
      const size = sandboxImageSize(status.imageBytes);
      const download = status.imageSource === "bundled"
        ? size === null ? t("sandbox.preparing") : t("sandbox.prepare_size", undefined, { size })
        : size === null ? t("sandbox.downloading") : t("sandbox.download_size", undefined, { size });
      const labels = { download, start: t("sandbox.start"), folders: t("sandbox.connecting_folders") };
      return {
        kind: "progress",
        estimate: sandboxEstimateText(status.estimatedRemainingMs),
        steps: STEP_IDS.map((id) => {
          const step = status.steps.find((entry) => entry.id === id);
          const state = step?.state ?? (status.state === "idle" && id === "download" ? "active" : "waiting");
          const total = step?.totalBytes ?? 0;
          const value = state === "done" ? 100 : total > 0
            ? Math.max(0, Math.min(100, ((step?.completedBytes ?? 0) / total) * 100))
            : state === "active" ? null : 0;
          return { id, label: labels[id], state, value };
        }),
      };
    }
    default: return { kind: "none" };
  }
}

export function sandboxRetryStarted(previous: OpenworkSandboxStatusResponse | null | undefined): OpenworkSandboxStatusResponse | null {
  if (!previous) return null;
  return {
    ...previous,
    state: "preparing",
    error: null,
    estimatedRemainingMs: null,
    steps: previous.steps.map((step, index) => ({ id: step.id, state: index === 0 ? "active" : "waiting" })),
  };
}
