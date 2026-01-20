import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { Mode, OnboardingStep } from "../app/types";
import type { WorkspaceInfo } from "../lib/tauri";
import { ArrowLeftRight, CheckCircle2, Circle, ChevronRight } from "lucide-solid";

import Button from "../components/Button";
import OnboardingWorkspaceSelector from "../components/OnboardingWorkspaceSelector";
import OpenWorkLogo from "../components/OpenWorkLogo";
import TextInput from "../components/TextInput";
import { currentLocale, t } from "../i18n";

export type OnboardingViewProps = {
  mode: Mode | null;
  onboardingStep: OnboardingStep;
  rememberModeChoice: boolean;
  busy: boolean;
  baseUrl: string;
  clientDirectory: string;
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
  onModeSelect: (mode: Mode) => void;
  onRememberModeToggle: () => void;
  onStartHost: () => void;
  onCreateWorkspace: (preset: "starter" | "automation" | "minimal", folder: string | null) => void;
  onPickWorkspaceFolder: () => Promise<string | null>;
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
};

export default function OnboardingView(props: OnboardingViewProps) {
  const [showAdvanced, setShowAdvanced] = createSignal(false);

  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());

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
        <div class="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative overflow-hidden">
          <div class="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-zinc-900 via-black to-black opacity-50" />
          <div class="z-10 flex flex-col items-center gap-6">
            <div class="relative">
              <div class="w-16 h-16 rounded-full border-2 border-zinc-800 flex items-center justify-center animate-spin-slow">
                <div class="w-12 h-12 rounded-full border-2 border-t-white border-zinc-800 animate-spin flex items-center justify-center bg-black">
                  <OpenWorkLogo size={20} class="text-white" />
                </div>
              </div>
            </div>
            <div class="text-center">
              <h2 class="text-xl font-medium mb-2">
                {props.mode === "host" ? translate("onboarding.starting_host") : translate("onboarding.searching_host")}
              </h2>
              <p class="text-zinc-500 text-sm">
                {props.mode === "host"
                  ? translate("onboarding.getting_ready")
                  : translate("onboarding.verifying")}
              </p>

            </div>
          </div>
        </div>
      </Match>

      <Match when={props.onboardingStep === "host"}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-900 to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-lg w-full z-10 space-y-6">
            <div class="text-center space-y-2">
              <div class="w-12 h-12 bg-white rounded-2xl mx-auto flex items-center justify-center shadow-2xl shadow-white/10 mb-6">
                <OpenWorkLogo size={18} class="text-black" />
              </div>
              <h2 class="text-2xl font-bold tracking-tight">
                {props.workspaces.length <= 1 ? translate("onboarding.create_first_workspace") : translate("onboarding.create_workspace")}
              </h2>
              <p class="text-zinc-400 text-sm leading-relaxed">
                {translate("onboarding.workspace_description")}
              </p>
            </div>

            <OnboardingWorkspaceSelector
              defaultPath={translate("onboarding.default_workspace_path")}
              onConfirm={props.onCreateWorkspace}
              onPickFolder={props.onPickWorkspaceFolder}
            />
              <Button onClick={props.onStartHost} disabled={props.busy || !props.activeWorkspacePath.trim()} class="w-full py-3 text-base">
              {translate("onboarding.start")}
            </Button>

            <Button variant="ghost" onClick={props.onBackToMode} disabled={props.busy} class="w-full">
              {translate("onboarding.back")}
            </Button>

            <div class="pt-2">
              <button
                onClick={() => setShowAdvanced(!showAdvanced())}
                class="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors group px-1"
              >
                <ChevronRight
                  size={12}
                  class="transition-transform duration-200"
                  classList={{ "rotate-90": showAdvanced() }}
                />
                {translate("onboarding.advanced_settings")}
              </button>

              <Show when={showAdvanced()}>
                <div class="mt-3 space-y-3">
                  <div class="rounded-2xl bg-zinc-900/40 border border-zinc-800 p-4 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-white">{translate("onboarding.opencode_engine")}</div>
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={props.onRefreshEngineDoctor}
                        disabled={props.busy}
                      >
                        {translate("onboarding.refresh")}
                      </Button>
                    </div>
                    <div class="text-xs text-zinc-500">{engineStatusLabel()}</div>

                    <Show when={!engineDoctorAvailable()}>
                      <div class="text-xs text-zinc-500">
                        {props.isWindows
                          ? translate("onboarding.windows_install_instruction")
                          : translate("onboarding.install_instruction")}
                      </div>
                      <div class="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          onClick={props.onInstallEngine}
                          disabled={props.busy || props.isWindows}
                          title={props.isWindows ? translate("onboarding.windows_install_hint") : ""}
                        >
                          {translate("onboarding.install")}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={props.onRefreshEngineDoctor}
                          disabled={props.busy}
                        >
                          {translate("onboarding.recheck")}
                        </Button>
                      </div>
                    </Show>

                    <Show when={engineDoctorAvailable()}>
                      <div class="text-xs text-zinc-600">
                        {translate("onboarding.ready_message")}
                      </div>
                    </Show>

                    <Show
                      when={
                        props.engineDoctorResolvedPath ||
                        props.engineDoctorVersion ||
                        props.engineDoctorNotes.length ||
                        serveHelpOutput()
                      }
                    >
                      <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 space-y-3 text-xs text-zinc-400">
                        <Show when={props.engineDoctorResolvedPath}>
                          <div>
                            <div class="text-[11px] text-zinc-500">{translate("onboarding.resolved_path")}</div>
                            <div class="font-mono break-all">{props.engineDoctorResolvedPath}</div>
                          </div>
                        </Show>
                        <Show when={props.engineDoctorVersion}>
                          <div>
                            <div class="text-[11px] text-zinc-500">{translate("onboarding.version")}</div>
                            <div class="font-mono">{props.engineDoctorVersion}</div>
                          </div>
                        </Show>
                        <Show when={props.engineDoctorNotes.length}>
                          <div>
                            <div class="text-[11px] text-zinc-500">{translate("onboarding.search_notes")}</div>
                            <pre class="whitespace-pre-wrap break-words text-xs text-zinc-400">
                              {props.engineDoctorNotes.join("\n")}
                            </pre>
                          </div>
                        </Show>
                        <Show when={serveHelpOutput()}>
                          <div>
                            <div class="text-[11px] text-zinc-500">{translate("onboarding.serve_help")}</div>
                            <pre class="whitespace-pre-wrap break-words text-xs text-zinc-400">
                              {serveHelpOutput()}
                            </pre>
                          </div>
                        </Show>
                      </div>
                    </Show>

                    <Show when={props.engineInstallLogs}>
                      <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-400 whitespace-pre-wrap max-h-40 overflow-auto font-mono">
                        {props.engineInstallLogs}
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>

           

            <Show when={props.error}>
              <div class="rounded-2xl bg-red-950/40 px-5 py-4 text-sm text-red-200 border border-red-500/20">
                {props.error}
              </div>
            </Show>
          </div>
        </div>
      </Match>

      <Match when={props.onboardingStep === "client"}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-900 to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-md w-full z-10 space-y-8">
              <div class="text-center space-y-2">
                <div class="w-12 h-12 bg-zinc-900 rounded-2xl mx-auto flex items-center justify-center border border-zinc-800 mb-6">
                  <ArrowLeftRight size={20} class="text-zinc-400" />
                </div>
                <h2 class="text-2xl font-bold tracking-tight">{translate("onboarding.connect_host")}</h2>
              <p class="text-zinc-400 text-sm leading-relaxed">
                {translate("onboarding.connect_description")}
              </p>
            </div>

            <div class="space-y-4">
              <TextInput
                label={translate("onboarding.server_url")}
                placeholder={translate("onboarding.server_url_placeholder")}
                value={props.baseUrl}
                onInput={(e) => props.onBaseUrlChange(e.currentTarget.value)}
              />
              <TextInput
                label={translate("onboarding.directory")}
                placeholder={translate("onboarding.directory_placeholder")}
                value={props.clientDirectory}
                onInput={(e) => props.onClientDirectoryChange(e.currentTarget.value)}
                hint={translate("onboarding.directory_hint")}
              />

              <Button onClick={props.onConnectClient} disabled={props.busy || !props.baseUrl.trim()} class="w-full py-3 text-base">
                {translate("onboarding.connect")}
              </Button>

              <Button variant="ghost" onClick={props.onBackToMode} disabled={props.busy} class="w-full">
                {translate("onboarding.back")}
              </Button>

              <Show when={props.error}>
                <div class="rounded-2xl bg-red-950/40 px-5 py-4 text-sm text-red-200 border border-red-500/20">
                  {props.error}
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Match>

      <Match when={true}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-900 to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-xl w-full z-10 space-y-12">
            <div class="text-center space-y-4">
              <div class="flex items-center justify-center gap-3 mb-6">
                <div class="w-12 h-12 bg-white rounded-xl flex items-center justify-center">
                  <OpenWorkLogo size={24} class="text-black" />
                </div>
                <h1 class="text-3xl font-bold tracking-tight">OpenWork</h1>
              </div>
              <h2 class="text-xl text-zinc-400 font-light">{translate("onboarding.welcome_title")}</h2>
            </div>

            <div class="space-y-4">
              <button
                onClick={() => props.onModeSelect("host")}
                class="group w-full relative bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 p-6 md:p-8 rounded-3xl text-left transition-all duration-300 hover:shadow-2xl hover:shadow-indigo-500/10 hover:-translate-y-0.5 flex items-start gap-6"
              >
                <div class="shrink-0 w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center border border-indigo-500/20 group-hover:border-indigo-500/40 transition-colors">
                  <Circle size={18} class="text-indigo-400" />
                </div>
                <div>
                  <h3 class="text-xl font-medium text-white mb-2">{translate("onboarding.run_local")}</h3>
                  <p class="text-zinc-500 text-sm leading-relaxed mb-4">
                    {translate("onboarding.run_local_description")}
                  </p>
                  <Show when={props.developerMode}>
                    <div class="flex items-center gap-2 text-xs font-mono text-indigo-400/80 bg-indigo-900/10 w-fit px-2 py-1 rounded border border-indigo-500/10">
                      <div class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                      {props.localHostLabel}
                    </div>
                  </Show>
                </div>
              </button>

              <Show when={props.engineRunning && props.engineBaseUrl}>
                <div class="rounded-2xl bg-zinc-900/40 border border-zinc-800 p-5 flex items-center justify-between">
                  <div>
                    <div class="text-sm text-white font-medium">{translate("onboarding.engine_running")}</div>
                    <div class="text-xs text-zinc-500">{translate("onboarding.attach_description")}</div>
                    <Show when={props.developerMode}>
                      <div class="text-xs text-zinc-500 font-mono truncate max-w-[14rem] md:max-w-[22rem]">
                        {props.engineBaseUrl}
                      </div>
                    </Show>
                  </div>
                  <Button variant="secondary" onClick={props.onAttachHost} disabled={props.busy}>
                    {translate("onboarding.attach")}
                  </Button>
                </div>
              </Show>

              <div class="flex items-center gap-2 px-2 py-1">
                <button
                  onClick={props.onRememberModeToggle}
                  class="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors group"
                >
                  <div
                    class={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                      props.rememberModeChoice
                        ? "bg-indigo-500 border-indigo-500 text-black"
                        : "border-zinc-700 bg-transparent group-hover:border-zinc-500"
                    }`}
                  >
                    <Show when={props.rememberModeChoice}>
                      <CheckCircle2 size={10} />
                    </Show>
                  </div>
                  {translate("onboarding.remember_choice")}
                </button>
              </div>

              <div class="pt-6 border-t border-zinc-900 flex justify-center">
                <button
                  onClick={() => props.onModeSelect("client")}
                  class="text-zinc-600 hover:text-zinc-400 text-sm font-medium transition-colors flex items-center gap-2 px-4 py-2 rounded-lg hover:bg-zinc-900/50"
                >
                  {translate("onboarding.client_mode")}
                </button>
              </div>

              <Show when={props.error}>
                <div class="rounded-2xl bg-red-950/40 px-5 py-4 text-sm text-red-200 border border-red-500/20">
                  {props.error}
                </div>
              </Show>

              <Show when={props.developerMode}>
                <div class="text-center text-xs text-zinc-700">{props.localHostLabel}</div>
              </Show>
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
