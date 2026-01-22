import { Match, Show, Switch } from "solid-js";

import { formatBytes, formatRelativeTime, isTauriRuntime } from "../utils";
import { t, type Language, LANGUAGE_OPTIONS } from "../../i18n";

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
  locale: Language;
  setLocale: (locale: Language) => void;
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
        return t("settings.connected_label");
      case "connecting":
        return t("settings.reload_required_label");
      case "error":
        return t("settings.connection_failed_label");
      default:
        return t("settings.not_connected_label");
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
        <div class="text-sm font-medium text-gray-12">{t("settings.connection_title")}</div>
        <div class="text-xs text-gray-10">{props.headerStatus}</div>
        <div class="text-xs text-gray-7 font-mono">{props.baseUrl}</div>
        <div class="pt-2 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={props.toggleDeveloperMode}>
            <Shield size={16} />
            {props.developerMode ? t("settings.disable_developer_mode") : t("settings.enable_developer_mode")}
          </Button>
          <Show when={props.mode === "host"}>
            <Button variant="danger" onClick={props.stopHost} disabled={props.busy}>
              {t("settings.stop_engine")}
            </Button>
          </Show>
          <Show when={props.mode === "client"}>
            <Button variant="outline" onClick={props.stopHost} disabled={props.busy}>
              {t("settings.disconnect")}
            </Button>
          </Show>
        </div>

      </div>


      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{t("settings.model_title")}</div>
          <div class="text-xs text-gray-10">{t("settings.model_description")}</div>
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
            {t("settings.change")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{t("settings.thinking_label")}</div>
            <div class="text-xs text-gray-7">{t("settings.thinking_description")}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.toggleShowThinking}
            disabled={props.busy}
          >
            {props.showThinking ? t("settings.on") : t("settings.off")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{t("settings.model_variant_label")}</div>
            <div class="text-xs text-gray-7 font-mono truncate">{props.modelVariantLabel}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.editModelVariant}
            disabled={props.busy}
          >
            {t("settings.edit")}
          </Button>
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{t("settings.language_title")}</div>
          <div class="text-xs text-gray-10">{t("settings.language_description")}</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{t("settings.language_current")}</div>
            <div class="text-xs text-gray-7">{LANGUAGE_OPTIONS.find(opt => opt.value === props.locale)?.nativeName ?? props.locale}</div>
          </div>
          <select
            value={props.locale}
            onChange={(e) => props.setLocale(e.currentTarget.value as Language)}
            disabled={props.busy}
            class="text-xs h-8 py-0 px-3 rounded-lg border border-gray-6 bg-gray-2 text-gray-12 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option value={option.value}>{option.nativeName}</option>
            ))}
          </select>
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{t("settings.appearance_title")}</div>
          <div class="text-xs text-gray-10">{t("settings.appearance_description")}</div>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button
            variant={props.themeMode === "system" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setThemeMode("system")}
            disabled={props.busy}
          >
            {t("settings.theme_system")}
          </Button>
          <Button
            variant={props.themeMode === "light" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setThemeMode("light")}
            disabled={props.busy}
          >
            {t("settings.theme_light")}
          </Button>
          <Button
            variant={props.themeMode === "dark" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setThemeMode("dark")}
            disabled={props.busy}
          >
            {t("settings.theme_dark")}
          </Button>
        </div>

        <div class="text-xs text-gray-7">
          {t("settings.theme_system_notice")}
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{t("settings.demo_mode_title")}</div>
          <div class="text-xs text-gray-10">{t("settings.demo_mode_description")}</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{t("settings.enable_demo_mode_label")}</div>
            <div class="text-xs text-gray-7">{t("settings.enable_demo_mode_description")}</div>
          </div>
          <Button
            variant={props.demoMode ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.toggleDemoMode}
            disabled={props.busy}
          >
            {props.demoMode ? t("settings.on") : t("settings.off")}
          </Button>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button
            variant={props.demoSequence === "cold-open" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("cold-open")}
            disabled={props.busy || !props.demoMode}
          >
            {t("settings.demo_cold_open")}
          </Button>
          <Button
            variant={props.demoSequence === "scheduler" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("scheduler")}
            disabled={props.busy || !props.demoMode}
          >
            {t("settings.demo_scheduler")}
          </Button>
          <Button
            variant={props.demoSequence === "summaries" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("summaries")}
            disabled={props.busy || !props.demoMode}
          >
            {t("settings.demo_summaries")}
          </Button>
          <Button
            variant={props.demoSequence === "groceries" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("groceries")}
            disabled={props.busy || !props.demoMode}
          >
            {t("settings.demo_groceries")}
          </Button>
        </div>

        <div class="text-xs text-gray-7">
          {t("settings.demo_sequences_notice")}
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-sm font-medium text-gray-12">{t("settings.updates_title")}</div>
            <div class="text-xs text-gray-10">{t("settings.updates_description")}</div>
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
                      <div class="text-sm text-gray-12">{t("settings.automatic_checks_label")}</div>
                      <div class="text-xs text-gray-7">{t("settings.automatic_checks_description")}</div>
                    </div>
                    <button
                      class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                        props.updateAutoCheck
                          ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                          : "text-gray-10 border-gray-6 hover:text-gray-12"
                      }`}
                      onClick={props.toggleUpdateAutoCheck}
                    >
                      {props.updateAutoCheck ? t("settings.on") : t("settings.off")}
                    </button>
                  </div>

                  <div class="flex items-center justify-between gap-3 bg-gray-1 p-3 rounded-xl border border-gray-6">
                    <div class="space-y-0.5">
                      <div class="text-sm text-gray-12">
                        <Switch>
                          <Match when={updateState() === "checking"}>{t("settings.update_checking")}</Match>
                          <Match when={updateState() === "available"}>{t("settings.update_available", { version: updateVersion() })}</Match>
                          <Match when={updateState() === "downloading"}>{t("settings.update_downloading")}</Match>
                          <Match when={updateState() === "ready"}>{t("settings.update_ready", { version: updateVersion() })}</Match>
                          <Match when={updateState() === "error"}>{t("settings.update_failed")}</Match>
                          <Match when={true}>{t("settings.update_uptodate")}</Match>
                        </Switch>
                      </div>
                      <Show when={updateState() === "idle" && updateLastCheckedAt()}>
                        <div class="text-xs text-gray-7">
                          {t("settings.last_checked")} {formatRelativeTime(updateLastCheckedAt() as number)}
                        </div>
                      </Show>
                      <Show when={updateState() === "available" && updateDate()}>
                        <div class="text-xs text-gray-7">{t("settings.published_date")} {updateDate()}</div>
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
                        {t("settings.check")}
                      </Button>

                      <Show when={updateState() === "available"}>
                        <Button
                          variant="secondary"
                          class="text-xs h-8 py-0 px-3"
                          onClick={props.downloadUpdate}
                          disabled={props.busy || updateState() === "downloading"}
                        >
                          {t("settings.download")}
                        </Button>
                      </Show>

                      <Show when={updateState() === "ready"}>
                        <Button
                          variant="secondary"
                          class="text-xs h-8 py-0 px-3"
                          onClick={props.installUpdateAndRestart}
                          disabled={props.busy || props.anyActiveRuns}
                          title={props.anyActiveRuns ? t("settings.stop_runs_to_update") : ""}
                        >
                          {t("settings.install_restart")}
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
                {props.updateEnv?.reason ?? t("settings.updates_not_supported")}
              </div>
            </Show>
          }
        >
          <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
            {t("settings.updates_desktop_only")}
          </div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
        <div class="text-sm font-medium text-gray-12">{t("settings.startup_title")}</div>

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
            <span class="capitalize text-sm font-medium text-gray-12">{props.mode} {t("settings.mode_label")}</span>
          </div>
          <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={props.stopHost} disabled={props.busy}>
            {t("settings.switch")}
          </Button>
        </div>

        <Button variant="secondary" class="w-full justify-between group" onClick={props.onResetStartupPreference}>
          <span class="text-gray-11">{t("settings.reset_startup_mode")}</span>
          <RefreshCcw size={14} class="text-gray-10 group-hover:rotate-180 transition-transform" />
        </Button>

        <p class="text-xs text-gray-7">
          {t("settings.reset_startup_notice")}
        </p>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{t("settings.advanced_title")}</div>
          <div class="text-xs text-gray-10">{t("settings.advanced_description")}</div>
        </div>

        <Show when={isTauriRuntime() && props.mode === "host"}>
          <div class="space-y-3">
            <div class="text-xs text-gray-10">{t("settings.engine_source_label")}</div>
            <div class="grid grid-cols-2 gap-2">
              <Button
                variant={props.engineSource === "sidecar" ? "secondary" : "outline"}
                onClick={() => props.setEngineSource("sidecar")}
                disabled={props.busy || props.isWindows}
                title={props.isWindows ? t("settings.windows_bundle_unavailable") : ""}
              >
                {t("settings.engine_bundled")}
              </Button>
              <Button
                variant={props.engineSource === "path" ? "secondary" : "outline"}
                onClick={() => props.setEngineSource("path")}
                disabled={props.busy}
              >
                {t("settings.engine_path")}
              </Button>
            </div>
            <div class="text-[11px] text-gray-7">
              {t("settings.engine_source_notice")}
              <Show when={props.isWindows}>
                <span class="text-gray-10"> {t("settings.windows_bundle_unavailable_notice")}</span>
              </Show>
            </div>
          </div>
        </Show>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{t("settings.reset_onboarding_label")}</div>
            <div class="text-xs text-gray-7">{t("settings.reset_onboarding_description")}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("onboarding")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? t("settings.stop_runs_to_reset") : ""}
          >
            {t("settings.reset")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{t("settings.reset_app_data_label")}</div>
            <div class="text-xs text-gray-7">{t("settings.reset_app_data_description")}</div>
          </div>
          <Button
            variant="danger"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("all")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? t("settings.stop_runs_to_reset") : ""}
          >
            {t("settings.reset")}
          </Button>
        </div>

        <div class="text-xs text-gray-7">
          {t("settings.reset_notice")}
        </div>
      </div>

      <Show when={props.developerMode}>
        <section>
          <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">{t("settings.developer_title")}</h3>

          <div class="space-y-4">
            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm text-gray-12">{t("settings.opencode_cache_label")}</div>
                <div class="text-xs text-gray-7">
                  {t("settings.opencode_cache_description")}
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
                title={isTauriRuntime() ? "" : t("settings.cache_requires_desktop")}
              >
                {props.cacheRepairBusy ? t("settings.repairing_cache") : t("settings.repair_cache")}
              </Button>
            </div>

            <div class="grid md:grid-cols-2 gap-4">
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4">
                <div class="text-xs text-gray-10 mb-2">{t("settings.pending_permissions_label")}</div>
                <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                  {props.safeStringify(props.pendingPermissions)}
                </pre>
              </div>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4">
                <div class="text-xs text-gray-10 mb-2">{t("settings.recent_events_label")}</div>
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
