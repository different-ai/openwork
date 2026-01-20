import { Match, Show, Switch, createSignal } from "solid-js";

import { formatBytes, formatRelativeTime, isTauriRuntime } from "../app/utils";
import { currentLocale, t, LANGUAGE_OPTIONS, type Language } from "../i18n";

import Button from "../components/Button";
import LanguagePickerModal from "../components/LanguagePickerModal";
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
  language: Language;
  setLanguage: (lang: Language) => void;
};

export default function SettingsView(props: SettingsViewProps) {
  const [languagePickerOpen, setLanguagePickerOpen] = createSignal(false);

  // Translation helper that uses current language from props
  const translate = (key: string) => t(key, props.language);

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
        <div class="text-sm font-medium text-white">{translate("settings.connection")}</div>
        <div class="text-xs text-zinc-500">{props.headerStatus}</div>
        <div class="text-xs text-zinc-600 font-mono">{props.baseUrl}</div>
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
          <div class="pt-4 border-t border-zinc-800/60 space-y-3">
            <div class="text-xs text-zinc-500">{translate("settings.engine_source")}</div>
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
                title={props.isWindows ? translate("settings.sidecar_unsupported") : ""}
              >
                {translate("settings.engine_sidecar")}
              </Button>
            </div>
            <div class="text-[11px] text-zinc-600">
              {translate("settings.engine_source_description")}
              <Show when={props.isWindows}>
                <span class="text-zinc-500"> {translate("settings.sidecar_unavailable_detail")}</span>
              </Show>
            </div>
          </div>
        </Show>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-white">{translate("settings.language")}</div>
          <div class="text-xs text-zinc-500">{translate("settings.language.description")}</div>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">
              {LANGUAGE_OPTIONS.find((opt) => opt.value === props.language)?.nativeName}
            </div>
            <div class="text-xs text-zinc-600">
              {LANGUAGE_OPTIONS.find((opt) => opt.value === props.language)?.label}
            </div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => setLanguagePickerOpen(true)}
            disabled={props.busy}
          >
            {translate("common.change")}
          </Button>
        </div>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-white">{translate("settings.model")}</div>
          <div class="text-xs text-zinc-500">{translate("settings.model_description")}</div>
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
            {translate("settings.change")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{translate("settings.thinking")}</div>
            <div class="text-xs text-zinc-600">{translate("settings.thinking_description")}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.toggleShowThinking}
            disabled={props.busy}
          >
            {props.showThinking ? translate("settings.on") : translate("settings.off")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{translate("settings.model_variant")}</div>
            <div class="text-xs text-zinc-600 font-mono truncate">{props.modelVariantLabel}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.editModelVariant}
            disabled={props.busy}
          >
            {translate("settings.edit")}
          </Button>
        </div>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-white">{translate("settings.demo_mode")}</div>
          <div class="text-xs text-zinc-500">{translate("settings.demo_mode_description")}</div>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{translate("settings.enable_demo_mode")}</div>
            <div class="text-xs text-zinc-600">{translate("settings.enable_demo_mode_description")}</div>
          </div>
          <Button
            variant={props.demoMode ? "secondary" : "outline"}
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.toggleDemoMode}
            disabled={props.busy}
          >
            {props.demoMode ? translate("settings.on") : translate("settings.off")}
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

        <div class="text-xs text-zinc-600">
          {translate("settings.demo_sequences_notice")}
        </div>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-sm font-medium text-white">{translate("settings.updates")}</div>
            <div class="text-xs text-zinc-500">{translate("settings.updates_description")}</div>
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
                      <div class="text-sm text-white">{translate("settings.automatic_checks")}</div>
                      <div class="text-xs text-zinc-600">{translate("settings.automatic_checks_description")}</div>
                    </div>
                    <button
                      class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                        props.updateAutoCheck
                          ? "bg-white/10 text-white border-white/20"
                          : "text-zinc-500 border-zinc-800 hover:text-white"
                      }`}
                      onClick={props.toggleUpdateAutoCheck}
                    >
                      {props.updateAutoCheck ? translate("settings.on") : translate("settings.off")}
                    </button>
                  </div>

                  <div class="flex items-center justify-between gap-3 bg-zinc-950 p-3 rounded-xl border border-zinc-800">
                    <div class="space-y-0.5">
                      <div class="text-sm text-white">
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
                        <div class="text-xs text-zinc-600">
                          {translate("settings.last_checked")} {formatRelativeTime(updateLastCheckedAt() as number)}
                        </div>
                      </Show>
                      <Show when={updateState() === "available" && updateDate()}>
                        <div class="text-xs text-zinc-600">{translate("settings.published")} {updateDate()}</div>
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
                          title={props.anyActiveRuns ? "Stop active runs to update" : ""}
                        >
                          {translate("settings.install_restart")}
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
                {props.updateEnv?.reason ?? translate("settings.update_not_supported")}
              </div>
            </Show>
          }
        >
          <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-sm text-zinc-400">
            {translate("settings.update_desktop_only")}
          </div>
        </Show>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-3">
        <div class="text-sm font-medium text-white">{translate("settings.startup")}</div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800">
          <div class="flex items-center gap-3">
            <div
              class={`p-2 rounded-lg ${
                props.mode === "host" ? "bg-indigo-500/10 text-indigo-400" : "bg-emerald-500/10 text-emerald-400"
              }`}
            >
              <Show when={props.mode === "host"} fallback={<Smartphone size={18} />}>
                <HardDrive size={18} />
              </Show>
            </div>
            <span class="capitalize text-sm font-medium text-white">{props.mode} {translate("settings.mode_label")}</span>
          </div>
          <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={props.stopHost} disabled={props.busy}>
            {translate("settings.switch_mode")}
          </Button>
        </div>

        <Button variant="secondary" class="w-full justify-between group" onClick={props.onResetStartupPreference}>
          <span class="text-zinc-300">{translate("settings.reset_startup")}</span>
          <RefreshCcw size={14} class="text-zinc-500 group-hover:rotate-180 transition-transform" />
        </Button>

        <p class="text-xs text-zinc-600">
          {translate("settings.reset_startup_description")}
        </p>
      </div>

      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-white">{translate("settings.advanced")}</div>
          <div class="text-xs text-zinc-500">{translate("settings.advanced_description")}</div>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{translate("settings.reset_onboarding")}</div>
            <div class="text-xs text-zinc-600">{translate("settings.reset_onboarding_description")}</div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("onboarding")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
          >
            {translate("settings.reset")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-zinc-950 p-3 rounded-xl border border-zinc-800 gap-3">
          <div class="min-w-0">
            <div class="text-sm text-zinc-200">{translate("settings.reset_app_data")}</div>
            <div class="text-xs text-zinc-600">{translate("settings.reset_app_data_description")}</div>
          </div>
          <Button
            variant="danger"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.openResetModal("all")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
          >
            {translate("settings.reset")}
          </Button>
        </div>

        <div class="text-xs text-zinc-600">
          {translate("settings.requires_typing")} <span class="font-mono text-zinc-400">RESET</span> {translate("settings.will_restart")}
        </div>
      </div>

      <Show when={props.developerMode}>
        <section>
          <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">{translate("settings.developer")}</h3>

          <div class="space-y-4">
            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div class="min-w-0">
                <div class="text-sm text-zinc-200">{translate("settings.opencode_cache")}</div>
                <div class="text-xs text-zinc-600">
                  {translate("settings.opencode_cache_description")}
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
                title={isTauriRuntime() ? "" : translate("settings.cache_repair_requires_desktop")}
              >
                {props.cacheRepairBusy ? translate("settings.repairing_cache") : translate("settings.repair_cache")}
              </Button>
            </div>

            <div class="grid md:grid-cols-2 gap-4">
              <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4">
                <div class="text-xs text-zinc-500 mb-2">{translate("settings.pending_permissions")}</div>
                <pre class="text-xs text-zinc-200 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                  {props.safeStringify(props.pendingPermissions)}
                </pre>
              </div>
              <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4">
                <div class="text-xs text-zinc-500 mb-2">{translate("settings.recent_events")}</div>
                <pre class="text-xs text-zinc-200 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                  {props.safeStringify(props.events)}
                </pre>
              </div>
            </div>
          </div>
        </section>
      </Show>

      <LanguagePickerModal
        open={languagePickerOpen()}
        currentLanguage={props.language}
        onSelect={(lang) => props.setLanguage(lang)}
        onClose={() => setLanguagePickerOpen(false)}
      />
    </section>
  );
}
