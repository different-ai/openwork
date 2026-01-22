import { Match, Show, Switch } from "solid-js";

import { formatBytes, formatRelativeTime, isTauriRuntime } from "../utils";

import Button from "../components/button";
import { HardDrive, RefreshCcw, Shield, Smartphone } from "lucide-solid";

export type SettingsViewProps = {
  mode: "host" | "client" | null;
  baseUrl: string;
  headerStatus: string;
  busy: boolean;
  developerMode: boolean;
  toggleDeveloperMode: () => void;
  stopHost: () => void;
  engineSource: "path" | "sidecar";
  setEngineSource: (value: "path" | "sidecar") => void;
  isWindows: boolean;
  defaultModelLabel: string;
  defaultModelRef: string;
  openDefaultModelPicker: () => void;
  showThinking: boolean;
  toggleShowThinking: () => void;
  modelVariantLabel: string;
  editModelVariant: () => void;
  demoMode: boolean;
  toggleDemoMode: () => void;
  demoSequence: "cold-open" | "scheduler" | "summaries" | "groceries";
  setDemoSequence: (value: "cold-open" | "scheduler" | "summaries" | "groceries") => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
  updateStatus: {
    state: string;
    lastCheckedAt?: number | null;
    version?: string;
    date?: string;
    notes?: string;
    totalBytes?: number | null;
    downloadedBytes?: number;
    message?: string;
  } | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  appVersion: string | null;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdateAndRestart: () => void;
  anyActiveRuns: boolean;
  onResetStartupPreference: () => void;
  openResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  pendingPermissions: unknown;
  events: unknown;
  safeStringify: (value: unknown) => string;
  repairOpencodeCache: () => void;
  cacheRepairBusy: boolean;
  cacheRepairResult: string | null;
  notionStatus: "disconnected" | "connecting" | "connected" | "error";
  notionStatusDetail: string | null;
  notionError: string | null;
  notionBusy: boolean;
  connectNotion: () => void;
};

export default function SettingsView(props: SettingsViewProps) {
  const updateState = () => props.updateStatus?.state ?? "idle";
  const updateNotes = () => props.updateStatus?.notes ?? null;
  const updateVersion = () => props.updateStatus?.version ?? null;
  const updateDate = () => props.updateStatus?.date ?? null;
  const updateLastCheckedAt = () => props.updateStatus?.lastCheckedAt ?? null;
  const updateDownloadedBytes = () => props.updateStatus?.downloadedBytes ?? null;
  const updateTotalBytes = () => props.updateStatus?.totalBytes ?? null;
  const updateErrorMessage = () => props.updateStatus?.message ?? null;

  const notionStatusLabel = () => {
    switch (props.notionStatus) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Reload required";
      case "error":
        return "Connection failed";
      default:
        return "Not connected";
    }
  };

  const notionStatusStyle = () => {
    if (props.notionStatus === "connected") {
      return "bg-green-7/10 text-green-11 border-green-7/20";
    }
    if (props.notionStatus === "error") {
      return "bg-red-7/10 text-red-11 border-red-7/20";
    }
    if (props.notionStatus === "connecting") {
      return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    }
    return "bg-gray-4/60 text-gray-11 border-gray-7/50";
  };


  return (
    <section class="space-y-6">
      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
        <div class="text-sm font-medium text-gray-12">Connection</div>
        <div class="text-xs text-gray-10">{props.headerStatus}</div>
        <div class="text-xs text-gray-7 font-mono">{props.baseUrl}</div>
        <div class="pt-2 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={props.toggleDeveloperMode}>
            <Shield size={16} />
            {props.developerMode ? "Disable Developer Mode" : "Enable Developer Mode"}
          </Button>
          <Show when={props.mode === "host"}>
            <Button variant="danger" onClick={props.stopHost} disabled={props.busy}>
              Stop engine
            </Button>
          </Show>
          <Show when={props.mode === "client"}>
            <Button variant="outline" onClick={props.stopHost} disabled={props.busy}>
              Disconnect
            </Button>
          </Show>
        </div>

      </div>


      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">Model</div>
          <div class="text-xs text-gray-10">Defaults + thinking controls for runs.</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12 truncate">{props.defaultModelLabel}</div>
            <div class="text-xs text-gray-7 font-mono truncate">{props.defaultModelRef}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.openDefaultModelPicker}
            disabled={props.busy}
          >
            Change
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">Thinking</div>
            <div class="text-xs text-gray-7">Show thinking parts (Developer mode only).</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.toggleShowThinking}
            disabled={props.busy}
          >
            {props.showThinking ? "On" : "Off"}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">Model variant</div>
            <div class="text-xs text-gray-7 font-mono truncate">{props.modelVariantLabel}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.editModelVariant}
            disabled={props.busy}
          >
            Edit
          </Button>
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">Appearance</div>
          <div class="text-xs text-gray-10">Match the system or force light/dark mode.</div>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button
            variant={props.themeMode === "system" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setThemeMode("system")}
            disabled={props.busy}
          >
            System
          </Button>
          <Button
            variant={props.themeMode === "light" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setThemeMode("light")}
            disabled={props.busy}
          >
            Light
          </Button>
          <Button
            variant={props.themeMode === "dark" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setThemeMode("dark")}
            disabled={props.busy}
          >
            Dark
          </Button>
        </div>

        <div class="text-xs text-gray-7">
          System mode follows your OS preference automatically.
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">Demo mode</div>
          <div class="text-xs text-gray-10">Lightweight scripted states for recording and review.</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">Enable demo mode</div>
            <div class="text-xs text-gray-7">Replaces live data with demo sequences.</div>
          </div>
          <Button
            variant={props.demoMode ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.toggleDemoMode}
            disabled={props.busy}
          >
            {props.demoMode ? "On" : "Off"}
          </Button>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button
            variant={props.demoSequence === "cold-open" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("cold-open")}
            disabled={props.busy || !props.demoMode}
          >
            Cold open
          </Button>
          <Button
            variant={props.demoSequence === "scheduler" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("scheduler")}
            disabled={props.busy || !props.demoMode}
          >
            Scheduler
          </Button>
          <Button
            variant={props.demoSequence === "summaries" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("summaries")}
            disabled={props.busy || !props.demoMode}
          >
            Summaries
          </Button>
          <Button
            variant={props.demoSequence === "groceries" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("groceries")}
            disabled={props.busy || !props.demoMode}
          >
            Groceries
          </Button>
        </div>

        <div class="text-xs text-gray-7">
          Demo sequences swap in scripted sessions, artifacts, and workspace context.
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-sm font-medium text-gray-12">Updates</div>
            <div class="text-xs text-gray-10">Keep OpenWork up to date.</div>
          </div>
          <div class="text-xs text-gray-7 font-mono">{props.appVersion ? `v${props.appVersion}` : ""}</div>
        </div>

        <Show
          when={!isTauriRuntime()}
          fallback={
            <Show
              when={props.updateEnv && props.updateEnv.supported === false}
              fallback={
                <>
                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                    <div class="space-y-0.5">
                      <div class="text-sm text-gray-12">Automatic checks</div>
                      <div class="text-xs text-gray-7">Once per day (quiet)</div>
                    </div>
                    <button
                      class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                        props.updateAutoCheck
                          ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                          : "text-gray-10 border-gray-6 hover:text-gray-12"
                      }`}
                      onClick={props.toggleUpdateAutoCheck}
                    >
                      {props.updateAutoCheck ? "On" : "Off"}
                    </button>
                  </div>

                  <div class="flex items-center justify-between gap-3 bg-gray-1 p-3 rounded-xl border border-gray-6">
                    <div class="space-y-0.5">
                      <div class="text-sm text-gray-12">
                        <Switch>
                          <Match when={updateState() === "checking"}>Checking...</Match>
                          <Match when={updateState() === "available"}>Update available: v{updateVersion()}</Match>
                          <Match when={updateState() === "downloading"}>Downloading...</Match>
                          <Match when={updateState() === "ready"}>Ready to install: v{updateVersion()}</Match>
                          <Match when={updateState() === "error"}>Update check failed</Match>
                          <Match when={true}>Up to date</Match>
                        </Switch>
                      </div>
                      <Show when={updateState() === "idle" && updateLastCheckedAt()}>
                        <div class="text-xs text-gray-7">
                          Last checked {formatRelativeTime(updateLastCheckedAt() as number)}
                        </div>
                      </Show>
                      <Show when={updateState() === "available" && updateDate()}>
                        <div class="text-xs text-gray-7">Published {updateDate()}</div>
                      </Show>
                      <Show when={updateState() === "downloading"}>
                        <div class="text-xs text-gray-7">
                          {formatBytes((updateDownloadedBytes() as number) ?? 0)}
                          <Show when={updateTotalBytes() != null}>
                            {` / ${formatBytes(updateTotalBytes() as number)}`}
                          </Show>
                        </div>
                      </Show>
                      <Show when={updateState() === "error"}>
                        <div class="text-xs text-red-11">{updateErrorMessage()}</div>
                      </Show>
                    </div>

                    <div class="flex items-center gap-2">
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={props.checkForUpdates}
                        disabled={props.busy || updateState() === "checking" || updateState() === "downloading"}
                      >
                        Check
                      </Button>

                      <Show when={updateState() === "available"}>
                        <Button
                          variant="secondary"
                          class="text-xs h-8 py-0 px-3"
                          onClick={props.downloadUpdate}
                          disabled={props.busy || updateState() === "downloading"}
                        >
                          Download
                        </Button>
                      </Show>

                      <Show when={updateState() === "ready"}>
                        <Button
                          variant="secondary"
                          class="text-xs h-8 py-0 px-3"
                          onClick={props.installUpdateAndRestart}
                          disabled={props.busy || props.anyActiveRuns}
                          title={props.anyActiveRuns ? "Stop active runs to update" : ""}
                        >
                          Install & Restart
                        </Button>
                      </Show>
                    </div>
                  </div>

                  <Show when={updateState() === "available" && updateNotes()}>
                    <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11 whitespace-pre-wrap max-h-40 overflow-auto">
                      {updateNotes()}
                    </div>
                  </Show>
                </>
              }
            >
              <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
                {props.updateEnv?.reason ?? "Updates are not supported in this environment."}
              </div>
            </Show>
          }
        >
          <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
            Updates are only available in the desktop app.
          </div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
        <div class="text-sm font-medium text-gray-12">Startup</div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
          <div class="flex items-center gap-3">
            <div
              class={`p-2 rounded-lg ${
                props.mode === "host" ? "bg-indigo-7/10 text-indigo-11" : "bg-green-7/10 text-green-11"
              }`}
            >
              <Show when={props.mode === "host"} fallback={<Smartphone size={18} />}>
                <HardDrive size={18} />
              </Show>
            </div>
            <span class="capitalize text-sm font-medium text-gray-12">{props.mode} mode</span>
          </div>
          <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={props.stopHost} disabled={props.busy}>
            Switch
          </Button>
        </div>

        <Button variant="secondary" class="w-full justify-between group" onClick={props.onResetStartupPreference}>
          <span class="text-gray-11">Reset default startup mode</span>
          <RefreshCcw size={14} class="text-gray-10 group-hover:rotate-180 transition-transform" />
        </Button>

        <p class="text-xs text-gray-7">
          This clears your saved preference and shows mode selection on next launch.
        </p>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">Advanced</div>
          <div class="text-xs text-gray-10">Power options for the engine and reset actions.</div>
        </div>

        <Show when={isTauriRuntime() && props.mode === "host"}>
          <div class="space-y-3">
            <div class="text-xs text-gray-10">Engine source</div>
            <div class="grid grid-cols-2 gap-2">
              <Button
                variant={props.engineSource === "sidecar" ? "secondary" : "outline"}
                onClick={() => props.setEngineSource("sidecar")}
                disabled={props.busy || props.isWindows}
                title={props.isWindows ? "Bundled engine is not supported on Windows yet" : ""}
              >
                Bundled (recommended)
              </Button>
              <Button
                variant={props.engineSource === "path" ? "secondary" : "outline"}
                onClick={() => props.setEngineSource("path")}
                disabled={props.busy}
              >
                System install (PATH)
              </Button>
            </div>
            <div class="text-[11px] text-gray-7">
              Bundled engine is the most reliable option. Use System install only if you manage OpenCode yourself.
              <Show when={props.isWindows}>
                <span class="text-gray-10"> Bundled engine is currently unavailable on Windows.</span>
              </Show>
            </div>
          </div>
        </Show>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">Reset onboarding</div>
            <div class="text-xs text-gray-7">Clears OpenWork preferences and restarts the app.</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("onboarding")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
          >
            Reset
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">Reset app data</div>
            <div class="text-xs text-gray-7">More aggressive. Clears OpenWork cache + app data.</div>
          </div>
          <Button
            variant="danger"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("all")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
          >
            Reset
          </Button>
        </div>

        <div class="text-xs text-gray-7">
          Requires typing <span class="font-mono text-gray-11">RESET</span> and will restart the app.
        </div>
      </div>

      <Show when={props.developerMode}>
        <section>
          <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">Developer</h3>

          <div class="space-y-4">
            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm text-gray-12">OpenCode cache</div>
                <div class="text-xs text-gray-7">
                  Repairs cached data used to start the engine. Safe to run.
                </div>
                <Show when={props.cacheRepairResult}>
                  <div class="text-xs text-gray-11 mt-2">{props.cacheRepairResult}</div>
                </Show>
              </div>
              <Button
                variant="secondary"
                class="text-xs h-8 py-0 px-3 shrink-0"
                onClick={props.repairOpencodeCache}
                disabled={props.cacheRepairBusy || !isTauriRuntime()}
                title={isTauriRuntime() ? "" : "Cache repair requires the desktop app"}
              >
                {props.cacheRepairBusy ? "Repairing cache" : "Repair cache"}
              </Button>
            </div>

            <div class="grid md:grid-cols-2 gap-4">
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4">
                <div class="text-xs text-gray-10 mb-2">Pending permissions</div>
                <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                  {props.safeStringify(props.pendingPermissions)}
                </pre>
              </div>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4">
                <div class="text-xs text-gray-10 mb-2">Recent events</div>
                <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                  {props.safeStringify(props.events)}
                </pre>
              </div>
            </div>
          </div>
        </section>
      </Show>
    </section>
  );
}
