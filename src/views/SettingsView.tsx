import { Match, Show, Switch } from "solid-js";

import { formatBytes, formatRelativeTime, isTauriRuntime } from "../app/utils";

import Button from "../components/Button";
import { HardDrive, RefreshCcw, Shield, Smartphone } from "lucide-solid";
import { useI18n } from "../i18n";

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
  const [t, { locale }] = useI18n();
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
        return t("common.connected");
      case "connecting":
        return t("common.connecting");
      case "error":
        return t("settings.connection.disconnect"); // Or a specific error key if preferred, using disconnect for now as per previous logic logic seems to map to failed
      default:
        return t("common.disconnected");
    }
  };

  const notionStatusStyle = () => {
    if (props.notionStatus === "connected") {
      return "bg-emerald-500/10 text-emerald-300 border-emerald-500/20";
    }
    if (props.notionStatus === "error") {
      return "bg-red-500/10 text-red-300 border-red-500/20";
    }
    if (props.notionStatus === "connecting") {
      return "bg-amber-500/10 text-amber-300 border-amber-500/20";
    }
    return "bg-zinc-800/60 text-zinc-400 border-zinc-700/50";
  };


  return (
    <section class="space-y-6">
      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
        <div class="text-sm font-medium text-white">{t("settings.general.title")}</div>
        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{t("settings.general.language")}</div>
            <div class="text-xs text-zinc-600">{t("settings.general.language_desc")}</div>
          </div>
          <div class="relative">
            <select
              value={locale()}
              onInput={(e) => locale(e.currentTarget.value as any)}
              class="appearance-none bg-zinc-950 border border-zinc-800 rounded-lg py-1.5 pl-3 pr-8 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-700"
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </select>
            <div class="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-500">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
        <div class="text-sm font-medium text-white">{t("settings.connection.title")}</div>
        <div class="text-xs text-zinc-500">{props.headerStatus}</div>
        <div class="text-xs text-zinc-600 font-mono">{props.baseUrl}</div>
        <div class="pt-2 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={props.toggleDeveloperMode}>
            <Shield size={16} />
            {props.developerMode ? t("settings.connection.disable_dev_mode") : t("settings.connection.enable_dev_mode")}
          </Button>
          <Show when={props.mode === "host"}>
            <Button variant="danger" onClick={props.stopHost} disabled={props.busy}>
              {t("settings.connection.stop_engine")}
            </Button>
          </Show>
          <Show when={props.mode === "client"}>
            <Button variant="outline" onClick={props.stopHost} disabled={props.busy}>
              {t("settings.connection.disconnect")}
            </Button>
          </Show>
        </div>

        <Show when={isTauriRuntime() && props.mode === "host"}>
          <div class="pt-4 border-t border-zinc-800/60 space-y-3">
            <div class="text-xs text-zinc-500">{t("settings.connection.engine_source")}</div>
            <div class="grid grid-cols-2 gap-2">
              <Button
                variant={props.engineSource === "path" ? "secondary" : "outline"}
                onClick={() => props.setEngineSource("path")}
                disabled={props.busy}
              >
                {t("settings.connection.path")}
              </Button>
              <Button
                variant={props.engineSource === "sidecar" ? "secondary" : "outline"}
                onClick={() => props.setEngineSource("sidecar")}
                disabled={props.busy || props.isWindows}
                title={props.isWindows ? t("settings.connection.sidecar_not_supported") : ""}
              >
                {t("settings.connection.sidecar")}
              </Button>
            </div>
            <div class="text-[11px] text-zinc-600">
              {t("settings.connection.path_desc")}
              <Show when={props.isWindows}>
                <span class="text-zinc-500"> {t("settings.connection.sidecar_unavailable")}</span>
              </Show>
            </div>
          </div>
        </Show>
      </div>


      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-white">{t("settings.model.title")}</div>
          <div class="text-xs text-zinc-500">{t("settings.model.subtitle")}</div>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200 truncate">{props.defaultModelLabel}</div>
            <div class="text-xs text-zinc-600 font-mono truncate">{props.defaultModelRef}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.openDefaultModelPicker}
            disabled={props.busy}
          >
            {t("settings.model.change")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{t("settings.model.thinking")}</div>
            <div class="text-xs text-zinc-600">{t("settings.model.thinking_desc")}</div>
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

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{t("settings.model.model_variant")}</div>
            <div class="text-xs text-zinc-600 font-mono truncate">{props.modelVariantLabel}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.editModelVariant}
            disabled={props.busy}
          >
            {t("settings.model.edit")}
          </Button>
        </div>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-white">{t("settings.demo_mode.title")}</div>
          <div class="text-xs text-zinc-500">{t("settings.demo_mode.subtitle")}</div>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{t("settings.demo_mode.enable")}</div>
            <div class="text-xs text-zinc-600">{t("settings.demo_mode.enable_desc")}</div>
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
            {t("settings.demo_mode.sequences.cold_open")}
          </Button>
          <Button
            variant={props.demoSequence === "scheduler" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("scheduler")}
            disabled={props.busy || !props.demoMode}
          >
            {t("settings.demo_mode.sequences.scheduler")}
          </Button>
          <Button
            variant={props.demoSequence === "summaries" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("summaries")}
            disabled={props.busy || !props.demoMode}
          >
            {t("settings.demo_mode.sequences.summaries")}
          </Button>
          <Button
            variant={props.demoSequence === "groceries" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("groceries")}
            disabled={props.busy || !props.demoMode}
          >
            {t("settings.demo_mode.sequences.groceries")}
          </Button>
        </div>

        <div class="text-xs text-zinc-600">
          {t("settings.demo_mode.footer")}
        </div>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-sm font-medium text-white">{t("settings.updates.title")}</div>
            <div class="text-xs text-zinc-500">{t("settings.updates.subtitle")}</div>
          </div>
          <div class="text-xs text-zinc-600 font-mono">{props.appVersion ? `v${props.appVersion}` : ""}</div>
        </div>

        <Show
          when={!isTauriRuntime()}
          fallback={
            <Show
              when={props.updateEnv && props.updateEnv.supported === false}
              fallback={
                <>
                  <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                    <div class="space-y-0.5">
                      <div class="text-sm text-white">{t("settings.updates.auto_check")}</div>
                      <div class="text-xs text-zinc-600">{t("settings.updates.auto_check_desc")}</div>
                    </div>
                    <button
                      class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${props.updateAutoCheck
                        ? "bg-white/10 text-white border-white/20"
                        : "text-zinc-500 border-zinc-800 hover:text-white"
                        }`}
                      onClick={props.toggleUpdateAutoCheck}
                    >
                      {props.updateAutoCheck ? "On" : "Off"}
                    </button>
                  </div>

                  <div class="flex items-center justify-between gap-3 bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                    <div class="space-y-0.5">
                      <div class="text-sm text-white">
                        <Switch>
                          <Match when={updateState() === "checking"}>{t("settings.updates.checking")}</Match>
                          <Match when={updateState() === "available"}>{t("settings.updates.available")}{updateVersion()}</Match>
                          <Match when={updateState() === "downloading"}>{t("settings.updates.downloading")}</Match>
                          <Match when={updateState() === "ready"}>{t("settings.updates.ready")}{updateVersion()}</Match>
                          <Match when={updateState() === "error"}>{t("settings.updates.failed")}</Match>
                          <Match when={true}>{t("settings.updates.up_to_date")}</Match>
                        </Switch>
                      </div>
                      <Show when={updateState() === "idle" && updateLastCheckedAt()}>
                        <div class="text-xs text-zinc-600">
                          {t("settings.updates.last_checked")} {formatRelativeTime(updateLastCheckedAt() as number)}
                        </div>
                      </Show>
                      <Show when={updateState() === "available" && updateDate()}>
                        <div class="text-xs text-zinc-600">{t("settings.updates.published")} {updateDate()}</div>
                      </Show>
                      <Show when={updateState() === "downloading"}>
                        <div class="text-xs text-zinc-600">
                          {formatBytes((updateDownloadedBytes() as number) ?? 0)}
                          <Show when={updateTotalBytes() != null}>
                            {` / ${formatBytes(updateTotalBytes() as number)}`}
                          </Show>
                        </div>
                      </Show>
                      <Show when={updateState() === "error"}>
                        <div class="text-xs text-red-300">{updateErrorMessage()}</div>
                      </Show>
                    </div>

                    <div class="flex items-center gap-2">
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={props.checkForUpdates}
                        disabled={props.busy || updateState() === "checking" || updateState() === "downloading"}
                      >
                        {t("settings.updates.check")}
                      </Button>

                      <Show when={updateState() === "available"}>
                        <Button
                          variant="secondary"
                          class="text-xs h-8 py-0 px-3"
                          onClick={props.downloadUpdate}
                          disabled={props.busy || updateState() === "downloading"}
                        >
                          {t("settings.updates.download")}
                        </Button>
                      </Show>

                      <Show when={updateState() === "ready"}>
                        <Button
                          variant="secondary"
                          class="text-xs h-8 py-0 px-3"
                          onClick={props.installUpdateAndRestart}
                          disabled={props.busy || props.anyActiveRuns}
                          title={props.anyActiveRuns ? t("settings.updates.stop_runs") : ""}
                        >
                          {t("settings.updates.install_restart")}
                        </Button>
                      </Show>
                    </div>
                  </div>

                  <Show when={updateState() === "available" && updateNotes()}>
                    <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-400 whitespace-pre-wrap max-h-40 overflow-auto">
                      {updateNotes()}
                    </div>
                  </Show>
                </>
              }
            >
              <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-sm text-zinc-400">
                {props.updateEnv?.reason ?? t("settings.updates.unsupported")}
              </div>
            </Show>
          }
        >
          <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-sm text-zinc-400">
            {t("settings.updates.desktop_only")}
          </div>
        </Show>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
        <div class="text-sm font-medium text-white">{t("settings.startup.title")}</div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800">
          <div class="flex items-center gap-3">
            <div
              class={`p-2 rounded-lg ${props.mode === "host" ? "bg-indigo-500/10 text-indigo-400" : "bg-emerald-500/10 text-emerald-400"
                }`}
            >
              <Show when={props.mode === "host"} fallback={<Smartphone size={18} />}>
                <HardDrive size={18} />
              </Show>
            </div>
            <span class="capitalize text-sm font-medium text-white">{props.mode} {t("settings.startup.mode")}</span>
          </div>
          <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={props.stopHost} disabled={props.busy}>
            {t("settings.startup.switch")}
          </Button>
        </div>

        <Button variant="secondary" class="w-full justify-between group" onClick={props.onResetStartupPreference}>
          <span class="text-zinc-300">{t("settings.startup.reset")}</span>
          <RefreshCcw size={14} class="text-zinc-500 group-hover:rotate-180 transition-transform" />
        </Button>

        <p class="text-xs text-zinc-600">
          {t("settings.startup.reset_desc")}
        </p>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-white">{t("settings.advanced.title")}</div>
          <div class="text-xs text-zinc-500">{t("settings.advanced.subtitle")}</div>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{t("settings.advanced.reset_onboarding")}</div>
            <div class="text-xs text-zinc-600">{t("settings.advanced.reset_onboarding_desc")}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("onboarding")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? t("settings.advanced.stop_runs_msg") : ""}
          >
            {t("settings.advanced.reset")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{t("settings.advanced.reset_app_data")}</div>
            <div class="text-xs text-zinc-600">{t("settings.advanced.reset_app_data_desc")}</div>
          </div>
          <Button
            variant="danger"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("all")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? t("settings.advanced.stop_runs_msg") : ""}
          >
            {t("settings.advanced.reset")}
          </Button>
        </div>

        <div class="text-xs text-zinc-600">
          {t("settings.advanced.reset_warning")}
        </div>
      </div>

      <Show when={props.developerMode}>
        <section>
          <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">{t("settings.developer.title")}</h3>

          <div class="space-y-4">
            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm text-zinc-200">{t("settings.developer.cache")}</div>
                <div class="text-xs text-zinc-600">
                  {t("settings.developer.cache_desc")}
                </div>
                <Show when={props.cacheRepairResult}>
                  <div class="text-xs text-zinc-400 mt-2">{props.cacheRepairResult}</div>
                </Show>
              </div>
              <Button
                variant="secondary"
                class="text-xs h-8 py-0 px-3 shrink-0"
                onClick={props.repairOpencodeCache}
                disabled={props.cacheRepairBusy || !isTauriRuntime()}
                title={isTauriRuntime() ? "" : t("settings.developer.desktop_only")}
              >
                {props.cacheRepairBusy ? t("settings.developer.repairing") : t("settings.developer.repair")}
              </Button>
            </div>

            <div class="grid md:grid-cols-2 gap-4">
              <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4">
                <div class="text-xs text-zinc-500 mb-2">{t("settings.developer.pending_permissions")}</div>
                <pre class="text-xs text-zinc-200 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                  {props.safeStringify(props.pendingPermissions)}
                </pre>
              </div>
              <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4">
                <div class="text-xs text-zinc-500 mb-2">{t("settings.developer.recent_events")}</div>
                <pre class="text-xs text-zinc-200 whitespace-pre-wrap break-words max-h-64 overflow-auto">
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
