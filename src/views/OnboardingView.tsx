import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { Mode, OnboardingStep } from "../app/types";
import type { WorkspaceInfo } from "../lib/tauri";
import { ArrowLeftRight, CheckCircle2, Circle, ChevronRight } from "lucide-solid";

import Button from "../components/Button";
import OnboardingWorkspaceSelector from "../components/OnboardingWorkspaceSelector";
import OpenWorkLogo from "../components/OpenWorkLogo";
import TextInput from "../components/TextInput";
import { useI18n } from "../i18n";

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
  const [t, { locale }] = useI18n();
  const [showAdvanced, setShowAdvanced] = createSignal(false);

  const engineDoctorAvailable = () =>
    props.engineDoctorFound === true && props.engineDoctorSupportsServe === true;

  const engineStatusLabel = () => {
    if (props.engineDoctorFound == null || props.engineDoctorSupportsServe == null) {
      return t("onboarding.host.checking");
    }
    if (!props.engineDoctorFound) return t("onboarding.host.not_found");
    if (!props.engineDoctorSupportsServe) return t("onboarding.host.update_needed");
    if (props.engineDoctorVersion) return `OpenCode ${props.engineDoctorVersion}`;
    return t("onboarding.host.ready");
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
                {props.mode === "host" ? t("onboarding.connecting.starting") : t("onboarding.connecting.searching")}
              </h2>
              <p class="text-zinc-500 text-sm">
                {props.mode === "host"
                  ? t("onboarding.connecting.getting_ready")
                  : t("onboarding.connecting.verifying")}
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
                {props.workspaces.length <= 1 ? t("onboarding.host.create_first") : t("onboarding.host.create")}
              </h2>
              <p class="text-zinc-400 text-sm leading-relaxed">
                {t("onboarding.host.desc")}
              </p>
            </div>

            <OnboardingWorkspaceSelector
              defaultPath="~/OpenWork/Workspace"
              onConfirm={props.onCreateWorkspace}
              onPickFolder={props.onPickWorkspaceFolder}
            />
            <Button onClick={props.onStartHost} disabled={props.busy || !props.activeWorkspacePath.trim()} class="w-full py-3 text-base">
              {t("onboarding.host.start")}
            </Button>

            <Button variant="ghost" onClick={props.onBackToMode} disabled={props.busy} class="w-full">
              {t("onboarding.host.back")}
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
                {t("onboarding.host.advanced")}
              </button>

              <Show when={showAdvanced()}>
                <div class="mt-3 space-y-3">
                  <div class="rounded-2xl bg-zinc-900/40 border border-zinc-800 p-4 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-white">{t("onboarding.host.engine_title")}</div>
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={props.onRefreshEngineDoctor}
                        disabled={props.busy}
                      >
                        {t("onboarding.host.refresh")}
                      </Button>
                    </div>
                    <div class="text-xs text-zinc-500">{engineStatusLabel()}</div>

                    <Show when={!engineDoctorAvailable()}>
                      <div class="text-xs text-zinc-500">
                        {props.isWindows
                          ? t("onboarding.host.install_windows")
                          : t("onboarding.host.install_mac")}
                      </div>
                      <div class="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          onClick={props.onInstallEngine}
                          disabled={props.busy || props.isWindows}
                          title={props.isWindows ? t("onboarding.host.install_manual") : ""}
                        >
                          {t("onboarding.host.install_btn")}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={props.onRefreshEngineDoctor}
                          disabled={props.busy}
                        >
                          {t("onboarding.host.recheck")}
                        </Button>
                      </div>
                    </Show>

                    <Show when={engineDoctorAvailable()}>
                      <div class="text-xs text-zinc-600">
                        {t("onboarding.host.ready_host")}
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
                            <div class="text-[11px] text-zinc-500">{t("onboarding.host.resolved_path")}</div>
                            <div class="font-mono break-all">{props.engineDoctorResolvedPath}</div>
                          </div>
                        </Show>
                        <Show when={props.engineDoctorVersion}>
                          <div>
                            <div class="text-[11px] text-zinc-500">{t("onboarding.host.version")}</div>
                            <div class="font-mono">{props.engineDoctorVersion}</div>
                          </div>
                        </Show>
                        <Show when={props.engineDoctorNotes.length}>
                          <div>
                            <div class="text-[11px] text-zinc-500">{t("onboarding.host.search_notes")}</div>
                            <pre class="whitespace-pre-wrap break-words text-xs text-zinc-400">
                              {props.engineDoctorNotes.join("\n")}
                            </pre>
                          </div>
                        </Show>
                        <Show when={serveHelpOutput()}>
                          <div>
                            <div class="text-[11px] text-zinc-500">serve --help output</div>
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
              <h2 class="text-2xl font-bold tracking-tight">{t("onboarding.client.title")}</h2>
              <p class="text-zinc-400 text-sm leading-relaxed">
                {t("onboarding.client.desc")}
              </p>
            </div>

            <div class="space-y-4">
              <TextInput
                label={t("onboarding.client.server_url")}
                placeholder="http://127.0.0.1:4096"
                value={props.baseUrl}
                onInput={(e) => props.onBaseUrlChange(e.currentTarget.value)}
              />
              <TextInput
                label={t("onboarding.client.directory")}
                placeholder="/path/to/project"
                value={props.clientDirectory}
                onInput={(e) => props.onClientDirectoryChange(e.currentTarget.value)}
                hint={t("onboarding.client.hint")}
              />

              <Button onClick={props.onConnectClient} disabled={props.busy || !props.baseUrl.trim()} class="w-full py-3 text-base">
                {t("onboarding.client.connect")}
              </Button>

              <Button variant="ghost" onClick={props.onBackToMode} disabled={props.busy} class="w-full">
                {t("onboarding.client.back")}
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

          <div class="absolute top-6 right-6 z-20">
            <div class="relative group">
              <select
                value={locale()}
                onInput={(e) => locale(e.currentTarget.value as any)}
                class="appearance-none bg-transparent hover:bg-zinc-900 border border-transparent hover:border-zinc-800 rounded-lg py-1.5 pl-3 pr-8 text-xs text-zinc-500 hover:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all cursor-pointer"
              >
                <option value="en">English</option>
                <option value="zh">中文</option>
              </select>
              <div class="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-600 group-hover:text-zinc-400 transition-colors">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </div>
            </div>
          </div>

          <div class="max-w-xl w-full z-10 space-y-12">
            <div class="text-center space-y-4">
              <div class="flex flex-col items-center justify-center gap-3 mb-6">
                <div class="w-12 h-12 bg-white rounded-xl flex items-center justify-center">
                  <OpenWorkLogo size={24} class="text-black" />
                </div>
                <h1 class="text-3xl font-bold tracking-tight">OpenWork</h1>
              </div>
              <h2 class="text-xl text-zinc-400 font-light">{t("onboarding.welcome.title")}</h2>
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
                  <h3 class="text-xl font-medium text-white mb-2">{t("onboarding.welcome.host_card.title")}</h3>
                  <p class="text-zinc-500 text-sm leading-relaxed mb-4">
                    {t("onboarding.welcome.host_card.desc")}
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
                    <div class="text-sm text-white font-medium">{t("onboarding.welcome.engine_running.title")}</div>
                    <div class="text-xs text-zinc-500">{t("onboarding.welcome.engine_running.desc")}</div>
                    <Show when={props.developerMode}>
                      <div class="text-xs text-zinc-500 font-mono truncate max-w-[14rem] md:max-w-[22rem]">
                        {props.engineBaseUrl}
                      </div>
                    </Show>
                  </div>
                  <Button variant="secondary" onClick={props.onAttachHost} disabled={props.busy}>
                    {t("onboarding.welcome.engine_running.attach")}
                  </Button>
                </div>
              </Show>

              <div class="flex items-center gap-2 px-2 py-1">
                <button
                  onClick={props.onRememberModeToggle}
                  class="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors group"
                >
                  <div
                    class={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${props.rememberModeChoice
                      ? "bg-indigo-500 border-indigo-500 text-black"
                      : "border-zinc-700 bg-transparent group-hover:border-zinc-500"
                      }`}
                  >
                    <Show when={props.rememberModeChoice}>
                      <CheckCircle2 size={10} />
                    </Show>
                  </div>
                  {t("onboarding.welcome.remember")}
                </button>
              </div>

              <div class="pt-6 border-t border-zinc-900 flex justify-center">
                <button
                  onClick={() => props.onModeSelect("client")}
                  class="text-zinc-600 hover:text-zinc-400 text-sm font-medium transition-colors flex items-center gap-2 px-4 py-2 rounded-lg hover:bg-zinc-900/50"
                >
                  {t("onboarding.welcome.client_link")}
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
