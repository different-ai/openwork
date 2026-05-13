/** @jsxImportSource react */
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, RefreshCcw, XCircle } from "lucide-react";

import type { SandboxBackend, SandboxProfile } from "../../../../app/lib/desktop";
import { Button } from "../../../design-system/button";
import type {
  OpenShellComponent,
  OpenShellDoctorResult,
  OpenShellInstallProgress,
  OpenShellInstallStatus,
} from "../state/openshell-state";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

type BackendOption = {
  value: SandboxBackend;
  label: string;
  summary: string;
  badge?: string;
};

const BACKEND_OPTIONS: BackendOption[] = [
  {
    value: "none",
    label: "No sandbox",
    summary: "Agents run directly on your laptop. Not recommended for production work.",
  },
  {
    value: "docker",
    label: "Docker",
    summary: "Container-level isolation. Requires Docker Desktop on Windows/Mac.",
  },
  {
    value: "microsandbox",
    label: "microsandbox",
    summary: "Apple container backend. Available on Apple Silicon (arm64) only.",
  },
  {
    value: "openshell",
    label: "OpenShell",
    summary: "Hardware-level (VM) isolation via NVIDIA OpenShell on Windows + WSL2. Strongest isolation for production-data work.",
    badge: "Recommended",
  },
];

type ProfileOption = {
  value: SandboxProfile;
  label: string;
  summary: string;
};

const PROFILE_OPTIONS: ProfileOption[] = [
  {
    value: "openwork",
    label: "OpenWork (default)",
    summary: "Bundled image with OpenCode. Rich chat UI in OpenWork.",
  },
  {
    value: "openeral-claude",
    label: "OpenEral — Claude Code",
    summary:
      "ghcr.io/sandys/openeral image with Claude Code as the agent. Workspace persists via PostgreSQL. Requires DATABASE_URL configured below.",
  },
  {
    value: "openeral-openclaw",
    label: "OpenEral — OpenClaw",
    summary:
      "Same OpenEral image, OpenClaw as the agent. Also requires ANTHROPIC_API_KEY to be configured below.",
  },
];

export type SandboxViewProps = {
  selectedBackend: SandboxBackend;
  onSelectBackend: (next: SandboxBackend) => void;
  selectedProfile: SandboxProfile;
  onSelectProfile: (next: SandboxProfile) => void;
  doctor: OpenShellDoctorResult | null;
  doctorLoading: boolean;
  doctorError: string | null;
  installStatus: OpenShellInstallStatus | null;
  progressLog: OpenShellInstallProgress[];
  policies: string[];
  actionBusy: boolean;
  actionError: string | null;
  onStartInstall: () => void;
  onCancelInstall: () => void;
  onRestartGateway: () => void;
  onResetDistro: () => void;
  onRefreshDoctor: () => void;
  onOpenPolicyFolder?: () => void;
  /** Host OS as reported by the platform kernel. Drives the install-button
   *  gate (OpenShell installs only on Windows). */
  os: "macos" | "windows" | "linux" | undefined;
};

function componentStateIcon(state: OpenShellComponent["state"]) {
  switch (state) {
    case "ok":
      return <CheckCircle2 size={16} className="text-green-9" />;
    case "warn":
      return <AlertTriangle size={16} className="text-amber-9" />;
    case "missing":
      return <XCircle size={16} className="text-red-9" />;
    default:
      return <CircleDashed size={16} className="text-gray-8" />;
  }
}

function doctorBannerClasses(status: OpenShellDoctorResult["status"] | undefined) {
  switch (status) {
    case "ready":
      return "border-green-7/50 bg-green-2/30 text-green-12";
    case "degraded":
      return "border-amber-7/50 bg-amber-2/30 text-amber-12";
    case "unsupported":
      return "border-red-7/50 bg-red-2/30 text-red-12";
    case "missing":
    default:
      return "border-gray-7/50 bg-gray-2/30 text-gray-12";
  }
}

function doctorBannerLabel(status: OpenShellDoctorResult["status"] | undefined) {
  switch (status) {
    case "ready":
      return "OpenShell is ready.";
    case "degraded":
      return "OpenShell is reachable but degraded.";
    case "missing":
      return "OpenShell is not installed yet.";
    case "unsupported":
      return "This system does not support OpenShell.";
    default:
      return "Checking OpenShell status…";
  }
}

function installCanStart(
  doctor: OpenShellDoctorResult | null,
  installStatus: OpenShellInstallStatus | null,
  os: SandboxViewProps["os"],
) {
  if (os !== "windows") return false;
  if (installStatus?.status === "running" || installStatus?.status === "cancelling") return false;
  if (doctor?.status === "unsupported") return false;
  return true;
}

export function SandboxView(props: SandboxViewProps) {
  const showOpenShellPanel = props.selectedBackend === "openshell";
  const running =
    props.installStatus?.status === "running" || props.installStatus?.status === "cancelling";
  const installButtonLabel = running
    ? "Installing…"
    : props.installStatus?.status === "reboot_required"
      ? "Resume after reboot"
      : props.installStatus?.status === "failed"
        ? "Retry install"
        : props.doctor?.status === "ready"
          ? "Reinstall / repair"
          : "Install OpenShell";

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-amber-7/40 bg-amber-2/20 p-3 text-xs text-amber-12">
        <strong>Heads up:</strong> Your backend choice is saved here, but the session-start flow
        in this build still routes through the Tauri bridge. Until that's rewired to Electron IPC
        (deferred follow-up), this selector affects new workspace metadata only — Open existing
        workspaces will keep whichever backend they were created with.
      </div>
      <div className={`${settingsPanelClass} space-y-3`}>
        <div>
          <div className="text-sm font-medium text-gray-12">Sandbox backend</div>
          <div className="text-xs text-gray-10">
            Choose how new workspaces isolate agent processes. You can override this per workspace
            when you create it.
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {BACKEND_OPTIONS.map((option) => {
            const checked = props.selectedBackend === option.value;
            return (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 transition-colors ${
                  checked
                    ? "border-dls-text/70 bg-gray-3/50"
                    : "border-dls-border bg-dls-surface hover:bg-gray-2/30"
                }`}
              >
                <input
                  type="radio"
                  name="sandbox-backend"
                  className="mt-1"
                  value={option.value}
                  checked={checked}
                  onChange={() => props.onSelectBackend(option.value)}
                />
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-12">{option.label}</span>
                    {option.badge ? (
                      <span className="rounded-full border border-green-7/60 bg-green-3/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-green-12">
                        {option.badge}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-gray-10">{option.summary}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      {showOpenShellPanel ? (
        <div className={`${settingsPanelClass} space-y-3`}>
          <div>
            <div className="text-sm font-medium text-gray-12">OpenShell launch profile</div>
            <div className="text-xs text-gray-10">
              Picks which agent + image runs inside the OpenShell sandbox. Default workspaces use
              the OpenWork image. OpenEral profiles boot from the published image at{" "}
              <code className="rounded bg-gray-2/40 px-1 py-0.5 text-[11px]">
                ghcr.io/sandys/openeral/sandbox:just-bash
              </code>{" "}
              and require credentials configured below.
            </div>
          </div>
          <div className="grid gap-2">
            {PROFILE_OPTIONS.map((option) => {
              const checked = props.selectedProfile === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 transition-colors ${
                    checked
                      ? "border-dls-text/70 bg-gray-3/50"
                      : "border-dls-border bg-dls-surface hover:bg-gray-2/30"
                  }`}
                >
                  <input
                    type="radio"
                    name="sandbox-profile"
                    className="mt-1"
                    value={option.value}
                    checked={checked}
                    onChange={() => props.onSelectProfile(option.value)}
                  />
                  <div className="space-y-0.5">
                    <div className="text-sm font-medium text-gray-12">{option.label}</div>
                    <div className="text-xs text-gray-10">{option.summary}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      {showOpenShellPanel ? (
        <div className={`${settingsPanelClass} space-y-4`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-gray-12">OpenShell health</div>
              <div className="text-xs text-gray-10">
                The Doctor checks each layer of the WSL2 / Docker / OpenShell stack. Status updates
                automatically every five seconds while this page is open.
              </div>
            </div>
            <Button
              variant="outline"
              className="h-8 rounded-full px-3 text-xs"
              onClick={props.onRefreshDoctor}
              disabled={props.doctorLoading}
              title="Refresh now"
            >
              {props.doctorLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCcw size={12} />
              )}
            </Button>
          </div>

          {props.os && props.os !== "windows" ? (
            <div className="rounded-xl border border-gray-6 bg-gray-1/40 p-3 text-sm text-gray-11">
              OpenShell only runs on Windows. On macOS/Linux, the app will fall back to Docker or
              microsandbox at session start.
            </div>
          ) : null}

          <div
            className={`rounded-xl border p-3 text-sm ${doctorBannerClasses(props.doctor?.status)}`}
          >
            <div className="font-medium">{doctorBannerLabel(props.doctor?.status)}</div>
            {props.doctor?.fatal?.length ? (
              <ul className="mt-1 list-disc pl-4 text-xs">
                {props.doctor.fatal.map((line, idx) => (
                  <li key={idx}>{line}</li>
                ))}
              </ul>
            ) : null}
            {props.doctorError ? (
              <div className="mt-1 text-xs">Doctor error: {props.doctorError}</div>
            ) : null}
          </div>

          {props.doctor?.components?.length ? (
            <div className="rounded-2xl border border-dls-border">
              {props.doctor.components.map((component, idx, all) => (
                <div
                  key={component.id}
                  className={`flex items-start gap-3 p-3 ${
                    idx < all.length - 1 ? "border-b border-dls-border" : ""
                  }`}
                >
                  <div className="pt-0.5">{componentStateIcon(component.state)}</div>
                  <div className="flex-1 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-12">{component.label}</span>
                      {component.version ? (
                        <span className="font-mono text-[11px] text-gray-7">{component.version}</span>
                      ) : null}
                    </div>
                    {component.detail ? (
                      <div className="text-xs text-gray-9">{component.detail}</div>
                    ) : null}
                    {component.actionable ? (
                      <div className="text-xs text-gray-11">→ {component.actionable}</div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={props.onStartInstall}
              disabled={
                !installCanStart(props.doctor, props.installStatus, props.os) || props.actionBusy
              }
            >
              {running ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
              {installButtonLabel}
            </Button>
            {running ? (
              <Button variant="outline" onClick={props.onCancelInstall} disabled={props.actionBusy}>
                Cancel install
              </Button>
            ) : null}
            {props.doctor?.status === "degraded" ? (
              <Button variant="outline" onClick={props.onRestartGateway} disabled={props.actionBusy}>
                Restart gateway
              </Button>
            ) : null}
            {/* Destructive — confirmation dialog lives in the main process. */}
            <Button
              variant="outline"
              className="border-red-7/50 text-red-12 hover:bg-red-2/30"
              onClick={props.onResetDistro}
              disabled={props.actionBusy || props.os !== "windows"}
              title="Wipes the distro and reruns setup. Use if OpenShell is corrupted."
            >
              Reset distro
            </Button>
          </div>

          {props.actionError ? (
            <div className="rounded-xl border border-red-7/40 bg-red-2/30 p-2 text-xs text-red-12">
              {props.actionError}
            </div>
          ) : null}

          {props.progressLog.length ? (
            <div className="rounded-xl border border-dls-border bg-gray-1/40 p-3">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-gray-8">
                Install activity
              </div>
              <div className="max-h-40 overflow-y-auto font-mono text-[11px] text-gray-11">
                {props.progressLog.slice(-50).map((event, idx) => (
                  <div key={idx} className="py-0.5">
                    <span className="text-gray-8">{event.phase}</span>
                    {event.status ? <span className="text-gray-7"> · {event.status}</span> : null}
                    {event.percent != null ? (
                      <span className="text-gray-7"> · {event.percent}%</span>
                    ) : null}
                    {event.message ? <span>: {event.message}</span> : null}
                    {event.error ? <span className="text-red-9"> — {event.error}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={`${settingsPanelClass} space-y-3`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-gray-12">Installed policies</div>
            <div className="text-xs text-gray-10">
              Policies define what each sandbox can reach over the network and filesystem.
            </div>
          </div>
          {props.onOpenPolicyFolder ? (
            <Button
              variant="outline"
              className="h-8 rounded-full px-3 text-xs"
              onClick={props.onOpenPolicyFolder}
            >
              Browse policy folder
            </Button>
          ) : null}
        </div>
        {props.policies.length === 0 ? (
          <div className="rounded-xl border border-gray-6 bg-gray-1/40 p-3 text-xs text-gray-10">
            No custom policies installed yet. The default banking policy ships with the app and is
            used when no override is specified.
          </div>
        ) : (
          <ul className="rounded-2xl border border-dls-border">
            {props.policies.map((policy, idx, all) => (
              <li
                key={policy}
                className={`px-3 py-2 text-sm text-gray-12 ${
                  idx < all.length - 1 ? "border-b border-dls-border" : ""
                }`}
              >
                {policy}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
