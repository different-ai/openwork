import { Match, Show, Switch } from "solid-js";

import { formatBytes, formatRelativeTime, isTauriRuntime } from "../utils";

import Button from "../components/button";
import { HardDrive, Languages, RefreshCcw, Shield, Smartphone } from "lucide-solid";
import { currentLocale, t, type Language } from "../../i18n";
import LanguagePickerModal from "../components/language-picker-modal";

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
  currentLanguage: Language;
  languagePickerOpen: boolean;
  openLanguagePicker: () => void;
  closeLanguagePicker: () => void;
  handleLanguageSelect: (language: Language) => void;
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
  const translate = (key: string) => t(key, currentLocale());
  
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
        return translate("settings.notion_connected");
      case "connecting":
        return translate("settings.reload_required");
      case "error":
        return translate("settings.connection_failed");
      default:
        return translate("settings.notion_not_connected");
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
        <div class="text-sm font-medium text-gray-12">{translate("settings.connection_title")}</div>
        <div class="text-xs text-gray-10">{props.headerStatus}</div>
        <div class="text-xs text-gray-7 font-mono">{props.baseUrl}</div>
        <div class="pt-2 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={props.toggleDeveloperMode}>
            <Shield size={16} />
            {props.developerMode ? translate("settings.disable_developer_mode") : translate("settings.enable_developer_mode")}
          </Button>
          <Show when={props.mode === "host"}>
            <Button variant="danger" onClick={props.stopHost} disabled={props.busy}>
              {translate("settings.stop_engine")}
            </Button>
          </Show>
          <Show when={props.mode === "client"}>
            <Button variant="outline" onClick={props.stopHost} disabled={props.busy}>
              {translate("settings.disconnect")}
            </Button>
          </Show>
        </div>

        <Show when={isTauriRuntime() && props.mode === "host"}>
          <div class="pt-4 border-t border-gray-6/60 space-y-3">
            <div class="text-xs text-gray-10">{translate("settings.engine_source_label")}</div>
            <div class="grid grid-cols-2 gap-2">
              <Button
                variant={props.engineSource === "path" ? "secondary" : "outline"}
                onClick={() => props.setEngineSource("path")}
                disabled={props.busy}
              >
                {translate("settings.engine_path")}
              </Button>
              <Button
                variant={props.engineSource === "sidecar" ? "secondary" : "outline"}
                onClick={() => props.setEngineSource("sidecar")}
                disabled={props.busy || props.isWindows}
                title={props.isWindows ? translate("settings.sidecar_unsupported_windows") : ""}
              >
                {translate("settings.engine_sidecar")}
              </Button>
            </div>
            <div class="text-[11px] text-gray-7">
              {translate("settings.engine_source_hint")}
              <Show when={props.isWindows}>
                <span class="text-gray-10"> {translate("settings.sidecar_unavailable")}</span>
              </Show>
            </div>
          </div>
        </Show>
      </div>


      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{translate("settings.model_title")}</div>
          <div class="text-xs text-gray-10">{translate("settings.model_hint")}</div>
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
            {translate("common.change")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{translate("settings.thinking_label")}</div>
            <div class="text-xs text-gray-7">{translate("settings.thinking_hint")}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.toggleShowThinking}
            disabled={props.busy}
          >
            {props.showThinking ? translate("common.on") : translate("common.off")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{translate("settings.model_variant_label")}</div>
            <div class="text-xs text-gray-7 font-mono truncate">{props.modelVariantLabel}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.editModelVariant}
            disabled={props.busy}
          >
            {translate("common.edit")}
          </Button>
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{translate("settings.appearance_title")}</div>
          <div class="text-xs text-gray-10">{translate("settings.appearance_hint")}</div>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button
            variant={props.themeMode === "system" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setThemeMode("system")}
            disabled={props.busy}
          >
            {translate("settings.theme_system")}
          </Button>
          <Button
            variant={props.themeMode === "light" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setThemeMode("light")}
            disabled={props.busy}
          >
            {translate("settings.theme_light")}
          </Button>
          <Button
            variant={props.themeMode === "dark" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setThemeMode("dark")}
            disabled={props.busy}
          >
            {translate("settings.theme_dark")}
          </Button>
        </div>

        <div class="text-xs text-gray-7">
          {translate("settings.theme_system_hint")}
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{translate("settings.language")}</div>
          <div class="text-xs text-gray-10">{translate("settings.language.description")}</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 flex items-center gap-3">
            <Languages size={18} class="text-gray-11" />
            <div>
              <div class="text-sm text-gray-12">
                {props.currentLanguage === "en" ? "English" : "简体中文"}
              </div>
              <div class="text-xs text-gray-7">
                {props.currentLanguage === "en" ? "English" : "Simplified Chinese"}
              </div>
            </div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.openLanguagePicker}
            disabled={props.busy}
          >
            {translate("settings.change")}
          </Button>
        </div>
      </div>

      <LanguagePickerModal
        open={props.languagePickerOpen}
        currentLanguage={props.currentLanguage}
        onSelect={props.handleLanguageSelect}
        onClose={props.closeLanguagePicker}
      />

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{translate("settings.demo_mode_title")}</div>
          <div class="text-xs text-gray-10">{translate("settings.demo_mode_hint")}</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{translate("settings.enable_demo_mode_label")}</div>
            <div class="text-xs text-gray-7">{translate("settings.enable_demo_mode_hint")}</div>
          </div>
          <Button
            variant={props.demoMode ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.toggleDemoMode}
            disabled={props.busy}
          >
            {props.demoMode ? translate("common.on") : translate("common.off")}
          </Button>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button
            variant={props.demoSequence === "cold-open" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("cold-open")}
            disabled={props.busy || !props.demoMode}
          >
            {translate("settings.demo_cold_open")}
          </Button>
          <Button
            variant={props.demoSequence === "scheduler" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("scheduler")}
            disabled={props.busy || !props.demoMode}
          >
            {translate("settings.demo_scheduler")}
          </Button>
          <Button
            variant={props.demoSequence === "summaries" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("summaries")}
            disabled={props.busy || !props.demoMode}
          >
            {translate("settings.demo_summaries")}
          </Button>
          <Button
            variant={props.demoSequence === "groceries" ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.setDemoSequence("groceries")}
            disabled={props.busy || !props.demoMode}
          >
            {translate("settings.demo_groceries")}
          </Button>
        </div>

        <div class="text-xs text-gray-7">
          {translate("settings.demo_sequences_hint")}
        </div>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-sm font-medium text-gray-12">{translate("settings.updates_title")}</div>
            <div class="text-xs text-gray-10">{translate("settings.updates_hint")}</div>
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
                      <div class="text-sm text-gray-12">{translate("settings.automatic_checks_label")}</div>
                      <div class="text-xs text-gray-7">{translate("settings.automatic_checks_hint")}</div>
                    </div>
                    <button
                      class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                        props.updateAutoCheck
                          ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                          : "text-gray-10 border-gray-6 hover:text-gray-12"
                      }`}
                      onClick={props.toggleUpdateAutoCheck}
                    >
                      {props.updateAutoCheck ? translate("common.on") : translate("common.off")}
                    </button>
                  </div>

                  <div class="flex items-center justify-between gap-3 bg-gray-1 p-3 rounded-xl border border-gray-6">
                    <div class="space-y-0.5">
                      <div class="text-sm text-gray-12">
                        <Switch>
                          <Match when={updateState() === "checking"}>{translate("settings.update_checking")}</Match>
                          <Match when={updateState() === "available"}>{translate("settings.update_available")} v{updateVersion()}</Match>
                          <Match when={updateState() === "downloading"}>{translate("settings.update_downloading")}</Match>
                          <Match when={updateState() === "ready"}>{translate("settings.update_ready")} v{updateVersion()}</Match>
                          <Match when={updateState() === "error"}>{translate("settings.update_error")}</Match>
                          <Match when={true}>{translate("settings.update_uptodate")}</Match>
                        </Switch>
                      </div>
                      <Show when={updateState() === "idle" && updateLastCheckedAt()}>
                        <div class="text-xs text-gray-7">
                          {translate("settings.last_checked_time", { time: formatRelativeTime(updateLastCheckedAt() as number) })}
                        </div>
                      </Show>
                      <Show when={updateState() === "available" && updateDate()}>
                        <div class="text-xs text-gray-7">{translate("settings.published_date", { date: updateDate() })}</div>
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
                        {translate("settings.check_update")}
                      </Button>

                      <Show when={updateState() === "available"}>
                        <Button
                          variant="secondary"
                          class="text-xs h-8 py-0 px-3"
                          onClick={props.downloadUpdate}
                          disabled={props.busy || updateState() === "downloading"}
                        >
                          {translate("settings.download_update")}
                        </Button>
                      </Show>

                      <Show when={updateState() === "ready"}>
                        <Button
                          variant="secondary"
                          class="text-xs h-8 py-0 px-3"
                          onClick={props.installUpdateAndRestart}
                          disabled={props.busy || props.anyActiveRuns}
                          title={props.anyActiveRuns ? translate("settings.stop_runs_to_update") : ""}
                        >
                          {translate("settings.install_update")}
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
                {props.updateEnv?.reason ?? translate("settings.updates_not_supported")}
              </div>
            </Show>
          }
        >
          <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
            {translate("settings.updates_desktop_only")}
          </div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
        <div class="text-sm font-medium text-gray-12">{translate("settings.startup_title")}</div>

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
            <span class="capitalize text-sm font-medium text-gray-12">{props.mode} {translate("settings.mode_suffix")}</span>
          </div>
          <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={props.stopHost} disabled={props.busy}>
            {translate("settings.switch_mode")}
          </Button>
        </div>

        <Button variant="secondary" class="w-full justify-between group" onClick={props.onResetStartupPreference}>
          <span class="text-gray-11">{translate("settings.reset_startup_label")}</span>
          <RefreshCcw size={14} class="text-gray-10 group-hover:rotate-180 transition-transform" />
        </Button>

        <p class="text-xs text-gray-7">
          {translate("settings.reset_startup_hint")}
        </p>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{translate("settings.advanced_title")}</div>
          <div class="text-xs text-gray-10">{translate("settings.advanced_hint")}</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{translate("settings.reset_onboarding_label")}</div>
            <div class="text-xs text-gray-7">{translate("settings.reset_onboarding_hint")}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("onboarding")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? translate("settings.stop_runs_to_reset") : ""}
          >
            {translate("settings.reset")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-gray-12">{translate("settings.reset_app_data_label")}</div>
            <div class="text-xs text-gray-7">{translate("settings.reset_app_data_hint")}</div>
          </div>
          <Button
            variant="danger"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("all")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? translate("settings.stop_runs_to_reset") : ""}
          >
            {translate("settings.reset")}
          </Button>
        </div>

        <div class="text-xs text-gray-7">
          {translate("settings.reset_requires_hint")}
        </div>
      </div>

      <Show when={props.developerMode}>
        <section>
          <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">{translate("settings.developer_title")}</h3>

          <div class="space-y-4">
            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm text-gray-12">{translate("settings.opencode_cache_label")}</div>
                <div class="text-xs text-gray-7">
                  {translate("settings.opencode_cache_hint")}
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
                title={isTauriRuntime() ? "" : translate("settings.cache_repair_requires_desktop")}
              >
                {props.cacheRepairBusy ? translate("settings.repairing_cache") : translate("settings.repair_cache")}
              </Button>
            </div>

            <div class="grid md:grid-cols-2 gap-4">
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4">
                <div class="text-xs text-gray-10 mb-2">{translate("settings.pending_permissions_label")}</div>
                <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                  {props.safeStringify(props.pendingPermissions)}
                </pre>
              </div>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4">
                <div class="text-xs text-gray-10 mb-2">{translate("settings.recent_events_label")}</div>
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
