import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { Mode, OnboardingStep } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";
import { CheckCircle2, ChevronDown, Circle, Globe } from "lucide-solid";

import Button from "../components/button";
import OnboardingWorkspaceSelector from "../components/onboarding-workspace-selector";
import OpenWorkLogo from "../components/openwork-logo";
import TextInput from "../components/text-input";
import { isTauriRuntime, isWindowsPlatform } from "../utils/index";
import { currentLocale, t } from "../../i18n";

export type OnboardingViewProps = {
  mode: Mode | null;
  onboardingStep: OnboardingStep;
  rememberModeChoice: boolean;
  busy: boolean;
  baseUrl: string;
  clientDirectory: string;
  openworkHostUrl: string;
  openworkToken: string;
  newAuthorizedDir: string;
  authorizedDirs: string[];
  activeWorkspacePath: string;
  workspaces: WorkspaceInfo[];
  localHostLabel: string;
  engineRunning: boolean;
  engineBaseUrl: string | null;
  engineDoctorFound: boolean | null;
  engineDoctorSupportsServe: boolean | null;
  engineDoctorVersion: string | null;
  engineDoctorResolvedPath: string | null;
  engineDoctorNotes: string[];
  engineDoctorServeHelpStdout: string | null;
  engineDoctorServeHelpStderr: string | null;
  engineDoctorCheckedAt: number | null;
  engineInstallLogs: string | null;
  error: string | null;
  developerMode: boolean;
  isWindows: boolean;
  onBaseUrlChange: (value: string) => void;
  onClientDirectoryChange: (value: string) => void;
  onOpenworkHostUrlChange: (value: string) => void;
  onOpenworkTokenChange: (value: string) => void;
  onModeSelect: (mode: Mode) => void;
  onRememberModeToggle: () => void;
  onStartHost: () => void;
  onCreateWorkspace: (preset: "starter" | "automation" | "minimal", folder: string | null) => void;
  onPickWorkspaceFolder: () => Promise<string | null>;
  onImportWorkspaceConfig: () => void;
  importingWorkspaceConfig: boolean;
  onAttachHost: () => void;
  onConnectClient: () => void;
  onBackToMode: () => void;
  onSetAuthorizedDir: (value: string) => void;
  onAddAuthorizedDir: () => void;
  onAddAuthorizedDirFromPicker: () => void;
  onRemoveAuthorizedDir: (index: number) => void;
  onRefreshEngineDoctor: () => void;
  onInstallEngine: () => void;
  onShowSearchNotes: () => void;
  onOpenSettings: () => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
};

export default function OnboardingView(props: OnboardingViewProps) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());
  const [openworkTokenVisible, setOpenworkTokenVisible] = createSignal(false);

  const engineDoctorAvailable = () =>
    props.engineDoctorFound === true && props.engineDoctorSupportsServe === true;

  const engineStatusLabel = () => {
    if (props.engineDoctorFound == null || props.engineDoctorSupportsServe == null) {
      return translate("onboarding.checking_cli");
    }
    if (!props.engineDoctorFound) return translate("onboarding.cli_not_found");
    if (!props.engineDoctorSupportsServe) return translate("onboarding.cli_needs_update");
    if (props.engineDoctorVersion) {
      return translate("onboarding.cli_version").replace("{version}", props.engineDoctorVersion);
    }
    return translate("onboarding.cli_ready");
  };

  const serveHelpOutput = () => {
    const parts = [
      props.engineDoctorServeHelpStdout,
      props.engineDoctorServeHelpStderr,
    ].filter((value): value is string => Boolean(value && value.trim()));
    return parts.join("\n\n");
  };

  return (
    <Switch>
      <Match when={props.onboardingStep === "connecting"}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-gray-1 text-gray-12 p-6 relative overflow-hidden">
          <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-gray-2 via-gray-1 to-gray-1 opacity-50" />
          <div class="z-10 flex flex-col items-center gap-6">
            <div class="relative">
              <OpenWorkLogo size={40} />
            </div>
            <div class="text-center">
              <h2 class="text-xl font-medium mb-2">
                {props.mode === "host" ? translate("onboarding.starting_host") : translate("onboarding.searching_host")}
              </h2>
              <p class="text-gray-10 text-sm">
                {props.mode === "host"
                  ? translate("onboarding.getting_ready")
                  : translate("onboarding.verifying")}
              </p>

            </div>
          </div>
        </div>
      </Match>

      <Match when={props.onboardingStep === "host"}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-gray-1 text-gray-12 p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-gray-2 to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-lg w-full z-10 space-y-6">
              <div class="text-center space-y-2">
                <div class="">
                  <OpenWorkLogo size={48} />
                </div>
              <h2 class="text-2xl font-bold tracking-tight">
                {props.workspaces.length <= 1 ? translate("onboarding.create_first_workspace") : translate("onboarding.create_workspace")}
              </h2>
              <p class="text-gray-11 text-sm leading-relaxed">
                  {translate("onboarding.workspace_folder_label")}
              </p>
            </div>

            <div class="space-y-4">
              <div class="bg-gray-2/40 border border-gray-6 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">{translate("onboarding.theme_label")}</div>
                  <div class="text-sm text-gray-12">{translate("onboarding.theme_current").replace("{mode}", props.themeMode)}</div>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    class={`text-xs px-3 py-1 rounded-full border transition-colors ${
                      props.themeMode === "system"
                        ? "bg-gray-12/10 text-gray-12 border-gray-6/30"
                        : "text-gray-10 border-gray-6 hover:text-gray-12"
                    }`}
                    onClick={() => props.setThemeMode("system")}
                  >
                    {translate("onboarding.theme_system")}
                  </button>
                  <button
                    class={`text-xs px-3 py-1 rounded-full border transition-colors ${
                      props.themeMode === "light"
                        ? "bg-gray-12/10 text-gray-12 border-gray-6/30"
                        : "text-gray-10 border-gray-6 hover:text-gray-12"
                    }`}
                    onClick={() => props.setThemeMode("light")}
                  >
                    {translate("onboarding.theme_light")}
                  </button>
                  <button
                    class={`text-xs px-3 py-1 rounded-full border transition-colors ${
                      props.themeMode === "dark"
                        ? "bg-gray-12/10 text-gray-12 border-gray-6/30"
                        : "text-gray-10 border-gray-6 hover:text-gray-12"
                    }`}
                    onClick={() => props.setThemeMode("dark")}
                  >
                    {translate("onboarding.theme_dark")}
                  </button>
                </div>
              </div>

              <OnboardingWorkspaceSelector
                defaultPath="~/OpenWork/Workspace"
                onConfirm={props.onCreateWorkspace}
                onPickFolder={props.onPickWorkspaceFolder}
              />

              <div class="rounded-2xl border border-gray-6 bg-gray-1/50 px-4 py-3">
                <div class="flex items-center justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">Import</div>
                    <div class="mt-1 text-sm text-gray-12">Use an existing workspace config.</div>
                    <div class="text-xs text-gray-10">Imports `.opencode` and `opencode.json` only.</div>
                  </div>
                  <Button
                    variant="secondary"
                    class="text-xs h-8 px-3 shrink-0"
                    onClick={props.onImportWorkspaceConfig}
                    disabled={props.importingWorkspaceConfig || props.busy}
                  >
                    Import config
                  </Button>
                </div>
              </div>

              <div class="rounded-2xl border border-gray-6 bg-gray-1/50 px-4 py-3">
                <div class="flex items-center justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">{translate("onboarding.access_label")}</div>
                    <div class="mt-1 text-sm text-gray-12">
                      {translate("onboarding.folders_allowed")
                        .replace("{count}", String(props.authorizedDirs.length))
                        .replace("{plural}", props.authorizedDirs.length === 1 ? "" : "s")}
                    </div>
                    <div class="text-xs text-gray-10">{translate("onboarding.manage_access_hint")}</div>
                  </div>
                  <div class="text-xs text-gray-7 font-mono truncate max-w-[9rem]">
                    <Show when={props.developerMode}>{props.authorizedDirs[0] ?? ""}</Show>
                  </div>
                </div>
              </div>
            </div>
            <Button
              onClick={props.onStartHost}
              disabled={props.busy || !props.activeWorkspacePath.trim()}
              class="w-full py-3 text-base"
            >
              {translate("onboarding.start")}
            </Button>

            <Button variant="ghost" onClick={props.onBackToMode} disabled={props.busy} class="w-full">
              {translate("onboarding.back")}
            </Button>

            <details class="rounded-2xl border border-gray-6 bg-gray-1/60 px-4 py-3">
              <summary class="flex items-center justify-between cursor-pointer text-xs text-gray-10">
                {translate("onboarding.advanced_settings")}
                <ChevronDown size={14} class="text-gray-7" />
              </summary>
              <div class="pt-3 space-y-3">
                <div class="text-xs text-gray-10">{translate("onboarding.manage_access_hint")}</div>

                <div class="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1/40 px-3 py-2">
                  <div class="text-xs text-gray-10">{translate("onboarding.open_settings_hint")}</div>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.onOpenSettings}
                  >
                    {translate("onboarding.open_settings")}
                  </Button>
                </div>

                <div class="space-y-3">
                  <div class="flex gap-2">
                    <input
                      class="w-full bg-gray-2/50 border border-gray-6 rounded-xl px-3 py-2 text-sm text-gray-12 placeholder-gray-7 focus:outline-none focus:ring-1 focus:ring-gray-8 focus:border-gray-8 transition-all"
                      placeholder={translate("onboarding.add_folder_path")}
                      value={props.newAuthorizedDir}
                      onInput={(e) => props.onSetAuthorizedDir(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          props.onAddAuthorizedDir();
                        }
                      }}
                    />
                    <Show when={isTauriRuntime()}>
                      <Button
                        variant="outline"
                        onClick={props.onAddAuthorizedDirFromPicker}
                        disabled={props.busy}
                      >
                        {translate("onboarding.pick")}
                      </Button>
                    </Show>
                    <Button
                      variant="secondary"
                      onClick={props.onAddAuthorizedDir}
                      disabled={!props.newAuthorizedDir.trim()}
                    >
                      {translate("onboarding.add")}
                    </Button>
                  </div>
                  <div class="text-xs text-gray-10">{engineStatusLabel()}</div>

                  <Show when={props.authorizedDirs.length}>
                    <div class="space-y-2">
                      <For each={props.authorizedDirs}>
                        {(dir, idx) => (
                          <div class="flex items-center justify-between gap-3 rounded-xl bg-gray-1/20 border border-gray-6 px-3 py-2">
                            <div class="min-w-0 text-xs font-mono text-gray-11 truncate">{dir}</div>
                            <Button
                              variant="ghost"
                              class="!p-2 rounded-lg text-xs text-gray-11 hover:text-gray-12"
                              onClick={() => props.onRemoveAuthorizedDir(idx())}
                              disabled={props.busy}
                              title={translate("onboarding.remove")}
                            >
                              {translate("onboarding.remove")}
                            </Button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>

                <Show when={isTauriRuntime() && props.developerMode}>
                  <div class="rounded-2xl bg-gray-2/40 border border-gray-6 p-4">
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0">
                        <div class="text-sm font-medium text-gray-12">{translate("onboarding.cli_label")}</div>
                        <div class="mt-1 text-xs text-gray-10">
                          <Show when={props.engineDoctorFound != null} fallback={<span>{translate("onboarding.cli_checking")}</span>}>
                            <Show when={props.engineDoctorFound} fallback={<span>{translate("onboarding.cli_not_found_hint")}</span>}>
                              <span class="font-mono">{props.engineDoctorVersion ?? translate("onboarding.cli_version_installed")}</span>
                              <Show when={props.engineDoctorResolvedPath}>
                                <span class="text-gray-7"> · </span>
                                <span class="font-mono text-gray-7 truncate">{props.engineDoctorResolvedPath}</span>
                              </Show>
                            </Show>
                          </Show>
                        </div>
                      </div>

                      <Button variant="secondary" onClick={props.onRefreshEngineDoctor} disabled={props.busy}>
                        {translate("onboarding.cli_recheck")}
                      </Button>
                    </div>

                    <Show when={props.engineDoctorFound === false}>
                      <div class="mt-4 space-y-2">
                        <div class="text-xs text-gray-10">
                          {isWindowsPlatform()
                            ? translate("onboarding.cli_install_commands")
                            : translate("onboarding.install_instruction")}
                        </div>
                        <Show when={isWindowsPlatform()}>
                          <div class="text-xs text-gray-10 space-y-1 font-mono">
                            <div>choco install opencode</div>
                            <div>scoop install extras/opencode</div>
                            <div>npm install -g opencode-ai</div>
                          </div>
                        </Show>
                        <div class="flex gap-2 pt-2">
                          <Button onClick={props.onInstallEngine} disabled={props.busy}>
                            {translate("onboarding.install")}
                          </Button>
                          <Button variant="outline" onClick={props.onShowSearchNotes} disabled={props.busy}>
                            {translate("onboarding.show_search_notes")}
                          </Button>
                        </div>
                      </div>
                    </Show>

                    <Show when={props.engineInstallLogs}>
                      <pre class="mt-4 max-h-48 overflow-auto rounded-xl bg-gray-1/50 border border-gray-6 p-3 text-xs text-gray-11 whitespace-pre-wrap">
                        {props.engineInstallLogs}
                      </pre>
                    </Show>

                    <Show when={props.engineDoctorCheckedAt != null}>
                      <div class="mt-3 text-[11px] text-gray-7">
                        {translate("onboarding.last_checked").replace("{time}", new Date(props.engineDoctorCheckedAt ?? 0).toLocaleTimeString())}
                      </div>
                    </Show>
                  </div>
                </Show>

                <Show when={!engineDoctorAvailable()}>
                  <div class="text-xs text-gray-10">
                    {props.isWindows
                      ? translate("onboarding.windows_install_instruction")
                      : translate("onboarding.install_instruction")}
                  </div>
                </Show>

                <Show when={engineDoctorAvailable()}>
                  <div class="text-xs text-gray-7">{translate("onboarding.ready_message")}</div>
                </Show>

                <Show
                  when={
                    props.engineDoctorResolvedPath ||
                    props.engineDoctorVersion ||
                    props.engineDoctorNotes.length ||
                    serveHelpOutput()
                  }
                >
                  <div class="rounded-xl bg-gray-1/40 border border-gray-6 p-3 space-y-3 text-xs text-gray-10">
                    <Show when={props.engineDoctorResolvedPath}>
                      <div>
                        <div class="text-[11px] text-gray-8">{translate("onboarding.resolved_path")}</div>
                        <div class="font-mono break-all">{props.engineDoctorResolvedPath}</div>
                      </div>
                    </Show>
                    <Show when={props.engineDoctorVersion}>
                      <div>
                        <div class="text-[11px] text-gray-8">{translate("onboarding.version")}</div>
                        <div class="font-mono">{props.engineDoctorVersion}</div>
                      </div>
                    </Show>
                    <Show when={props.engineDoctorNotes.length}>
                      <div>
                        <div class="text-[11px] text-gray-8">{translate("onboarding.search_notes")}</div>
                        <pre class="whitespace-pre-wrap break-words text-xs text-gray-10">
                          {props.engineDoctorNotes.join("\n")}
                        </pre>
                      </div>
                    </Show>
                    <Show when={serveHelpOutput()}>
                      <div>
                        <div class="text-[11px] text-gray-8">{translate("onboarding.serve_help")}</div>
                        <pre class="whitespace-pre-wrap break-words text-xs text-gray-10">{serveHelpOutput()}</pre>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </details>

            <Show when={props.error}>
              <div class="rounded-2xl bg-red-1/40 px-5 py-4 text-sm text-red-12 border border-red-7/20">
                {props.error}
              </div>
            </Show>
          </div>
        </div>
      </Match>

      <Match when={props.onboardingStep === "client"}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-gray-1 text-gray-12 p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-gray-2 to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-md w-full z-10 space-y-8">
              <div class="text-center space-y-2">
                <div class="w-12 h-12 bg-gray-2 rounded-2xl mx-auto flex items-center justify-center border border-gray-6 mb-6">
                  <Globe size={20} class="text-gray-11" />
                </div>
                <h2 class="text-2xl font-bold tracking-tight">{translate("onboarding.remote_workspace_title")}</h2>
              <p class="text-gray-11 text-sm leading-relaxed">
                  {translate("onboarding.remote_workspace_description")}
              </p>
            </div>

            <div class="space-y-4">
              <div class="rounded-2xl border border-gray-6 bg-gray-1/50 px-4 py-3">
                <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">
                  {translate("onboarding.remote_workspace_title")}
                </div>
                <div class="mt-1 text-sm text-gray-12">{translate("onboarding.remote_workspace_description")}</div>
              </div>

              <div class="space-y-4">
                <TextInput
                  label={translate("dashboard.openwork_host_label")}
                  placeholder={translate("dashboard.openwork_host_placeholder")}
                  value={props.openworkHostUrl}
                  onInput={(e) => props.onOpenworkHostUrlChange(e.currentTarget.value)}
                  hint={translate("dashboard.openwork_host_hint")}
                />

                <label class="block">
                  <div class="mb-1 text-xs font-medium text-gray-11">{translate("dashboard.openwork_host_token_label")}</div>
                  <div class="flex items-center gap-2">
                    <input
                      type={openworkTokenVisible() ? "text" : "password"}
                      value={props.openworkToken}
                      onInput={(e) => props.onOpenworkTokenChange(e.currentTarget.value)}
                      placeholder={translate("dashboard.openwork_host_token_placeholder")}
                      disabled={props.busy}
                      class="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
                    />
                    <Button
                      variant="outline"
                      class="text-xs h-9 px-3 shrink-0"
                      onClick={() => setOpenworkTokenVisible((prev) => !prev)}
                      disabled={props.busy}
                    >
                      {openworkTokenVisible() ? translate("common.hide") : translate("common.show")}
                    </Button>
                  </div>
                  <div class="mt-1 text-xs text-gray-10">{translate("dashboard.openwork_host_token_hint")}</div>
                </label>
              </div>

              <details class="rounded-2xl border border-gray-6 bg-gray-1/60 px-4 py-3">
                <summary class="flex items-center justify-between cursor-pointer text-xs text-gray-10">
                  {translate("onboarding.advanced_opencode_direct")}
                  <ChevronDown size={14} class="text-gray-7" />
                </summary>
                <div class="pt-3 space-y-3">
                  <div class="text-xs text-gray-10">{translate("onboarding.advanced_opencode_hint")}</div>
                  <TextInput
                    label={translate("dashboard.remote_base_url_label")}
                    placeholder={translate("dashboard.remote_base_url_placeholder")}
                    value={props.baseUrl}
                    onInput={(e) => props.onBaseUrlChange(e.currentTarget.value)}
                  />
                  <TextInput
                    label={translate("dashboard.remote_directory_label")}
                    placeholder={translate("dashboard.remote_directory_placeholder")}
                    value={props.clientDirectory}
                    onInput={(e) => props.onClientDirectoryChange(e.currentTarget.value)}
                    hint={translate("dashboard.remote_directory_hint")}
                  />
                </div>
              </details>

              <Button
                onClick={props.onConnectClient}
                disabled={props.busy || (!props.openworkHostUrl.trim() && !props.baseUrl.trim())}
                class="w-full py-3 text-base"
              >
                {translate("onboarding.remote_workspace_action")}
              </Button>

              <Button variant="ghost" onClick={props.onBackToMode} disabled={props.busy} class="w-full">
                {translate("onboarding.back")}
              </Button>

              <Show when={props.error}>
                <div class="rounded-2xl bg-red-1/40 px-5 py-4 text-sm text-red-12 border border-red-7/20">
                  {props.error}
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Match>

      <Match when={true}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-gray-1 text-gray-12 p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-gray-2 to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-xl w-full z-10 space-y-12">
            <div class="text-center space-y-4">
              <div class="flex items-center justify-center gap-3 mb-6">
                <div class="">
                  <OpenWorkLogo size={48} />
                </div>
                <h1 class="text-3xl font-bold tracking-tight text-gray-12">OpenWork</h1>
              </div>
              <h2 class="text-xl text-gray-11">{translate("onboarding.welcome_title")}</h2>
            </div>

            <div class="space-y-4">
              <button
                onClick={() => props.onModeSelect("host")}
                class="group w-full relative bg-gray-2 hover:bg-gray-4 border border-gray-6 hover:border-gray-7 p-6 md:p-8 rounded-3xl text-left transition-all duration-300 hover:shadow-2xl hover:shadow-indigo-6/10 hover:-translate-y-0.5 flex items-start gap-6"
              >
                <div class="shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-7/20 to-purple-7/20 flex items-center justify-center border border-indigo-7/20 group-hover:border-indigo-7/40 transition-colors">
                  <Circle size={18} class="text-indigo-11" />
                </div>
                <div>
                  <h3 class="text-xl font-medium text-gray-12 mb-2">{translate("onboarding.run_local")}</h3>
                  <p class="text-gray-10 text-sm leading-relaxed mb-4">
                      {translate("onboarding.run_local_description")}
                  </p>
                  <Show when={props.developerMode}>
                    <div class="flex items-center gap-2 text-xs font-mono text-indigo-11/80 bg-indigo-2/10 w-fit px-2 py-1 rounded border border-indigo-7/10">
                      <div class="w-1.5 h-1.5 rounded-full bg-indigo-8 animate-pulse" />
                      {props.localHostLabel}
                    </div>
                  </Show>
                </div>
              </button>

              <Show when={props.engineRunning && props.engineBaseUrl}>
                <div class="rounded-2xl bg-gray-2/40 border border-gray-6 p-5 flex items-center justify-between">
                  <div>
                    <div class="text-sm text-gray-12 font-medium">{translate("onboarding.engine_running")}</div>
                    <div class="text-xs text-gray-10">{translate("onboarding.attach_description")}</div>
                    <Show when={props.developerMode}>
                      <div class="text-xs text-gray-10 font-mono truncate max-w-[14rem] md:max-w-[22rem]">
                        {props.engineBaseUrl}
                      </div>
                    </Show>
                  </div>
                  <Button variant="secondary" onClick={props.onAttachHost} disabled={props.busy}>
                    {translate("onboarding.attach")}
                  </Button>
                </div>
              </Show>

              <button
                onClick={() => props.onModeSelect("client")}
                class="group w-full relative bg-gray-2 hover:bg-gray-4 border border-gray-6 hover:border-gray-7 p-6 md:p-8 rounded-3xl text-left transition-all duration-300 hover:shadow-2xl hover:shadow-gray-12/10 hover:-translate-y-0.5 flex items-start gap-6"
              >
                <div class="shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br from-gray-7/20 to-gray-5/10 flex items-center justify-center border border-gray-6 group-hover:border-gray-7 transition-colors">
                  <Globe size={18} class="text-gray-11" />
                </div>
                <div>
                  <h3 class="text-xl font-medium text-gray-12 mb-2">
                    {translate("onboarding.remote_workspace_card_title")}
                  </h3>
                  <p class="text-gray-10 text-sm leading-relaxed mb-4">
                    {translate("onboarding.remote_workspace_card_description")}
                  </p>
                </div>
              </button>

              <div class="flex items-center gap-2 px-2 py-1">
                <button
                  onClick={props.onRememberModeToggle}
                  class="flex items-center gap-2 text-xs text-gray-10 hover:text-gray-11 transition-colors group"
                >
                  <div
                    class={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                      props.rememberModeChoice
                        ? "bg-indigo-7 border-indigo-7 text-gray-12"
                        : "border-gray-7 bg-transparent group-hover:border-gray-7"
                    }`}
                  >
                    <Show when={props.rememberModeChoice}>
                      <CheckCircle2 size={10} />
                    </Show>
                  </div>
                  {translate("onboarding.remember_choice")}
                </button>
              </div>

              <Show when={props.error}>
                <div class="rounded-2xl bg-red-1/40 px-5 py-4 text-sm text-red-12 border border-red-7/20">
                  {props.error}
                </div>
              </Show>

              <Show when={props.developerMode}>
                <div class="text-center text-xs text-gray-8">{props.localHostLabel}</div>
              </Show>
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
