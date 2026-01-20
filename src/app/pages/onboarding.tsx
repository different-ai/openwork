import { For, Match, Show, Switch } from "solid-js";
import type { Mode, OnboardingStep } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";
import { ArrowLeftRight, CheckCircle2, Circle, ChevronDown } from "lucide-solid";

import Button from "../components/button";
import OnboardingWorkspaceSelector from "../components/onboarding-workspace-selector";
import OpenWorkLogo from "../components/openwork-logo";
import TextInput from "../components/text-input";
import { isTauriRuntime, isWindowsPlatform } from "../utils/index";

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
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
};

export default function OnboardingView(props: OnboardingViewProps) {
  const engineDoctorAvailable = () =>
    props.engineDoctorFound === true && props.engineDoctorSupportsServe === true;

  const engineStatusLabel = () => {
    if (props.engineDoctorFound == null || props.engineDoctorSupportsServe == null) {
      return "Checking OpenCode CLI...";
    }
    if (!props.engineDoctorFound) return "OpenCode CLI not found.";
    if (!props.engineDoctorSupportsServe) return "OpenCode CLI needs an update for serve.";
    if (props.engineDoctorVersion) return `OpenCode ${props.engineDoctorVersion}`;
    return "OpenCode CLI ready.";
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
              <div class="w-16 h-16 rounded-full border-2 border-gray-6 flex items-center justify-center animate-spin-slow">
                <div class="w-12 h-12 rounded-full border-2 border-t-gray-12 border-gray-6 animate-spin flex items-center justify-center bg-gray-1">
                  <OpenWorkLogo size={20} class="text-gray-12" />
                </div>
              </div>
            </div>
            <div class="text-center">
              <h2 class="text-xl font-medium mb-2">
                {props.mode === "host" ? "Starting OpenWork..." : "Searching for Host..."}
              </h2>
              <p class="text-gray-10 text-sm">
                {props.mode === "host"
                  ? "Getting everything ready"
                  : "Verifying secure handshake"}
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
              <div class="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center mb-6">
                <OpenWorkLogo size={18} class="text-gray-12" />
              </div>
              <h2 class="text-2xl font-bold tracking-tight">
                {props.workspaces.length <= 1 ? "Create your first workspace" : "Create a workspace"}
              </h2>
              <p class="text-gray-11 text-sm leading-relaxed">
                A workspace is a <span class="font-semibold text-gray-12">folder</span> with its own skills, plugins, and templates.
              </p>
            </div>

            <div class="space-y-4">
              <div class="bg-gray-2/40 border border-gray-6 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">Theme</div>
                  <div class="text-sm text-gray-12">Current: {props.themeMode}</div>
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
                    System
                  </button>
                  <button
                    class={`text-xs px-3 py-1 rounded-full border transition-colors ${
                      props.themeMode === "light"
                        ? "bg-gray-12/10 text-gray-12 border-gray-6/30"
                        : "text-gray-10 border-gray-6 hover:text-gray-12"
                    }`}
                    onClick={() => props.setThemeMode("light")}
                  >
                    Light
                  </button>
                  <button
                    class={`text-xs px-3 py-1 rounded-full border transition-colors ${
                      props.themeMode === "dark"
                        ? "bg-gray-12/10 text-gray-12 border-gray-6/30"
                        : "text-gray-10 border-gray-6 hover:text-gray-12"
                    }`}
                    onClick={() => props.setThemeMode("dark")}
                  >
                    Dark
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
                    <div class="text-xs font-semibold text-gray-10 uppercase tracking-wider">Access</div>
                    <div class="mt-1 text-sm text-gray-12">
                      {props.authorizedDirs.length} folder{props.authorizedDirs.length === 1 ? "" : "s"} allowed
                    </div>
                    <div class="text-xs text-gray-10">You can manage access in advanced settings.</div>
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
              Start OpenWork
            </Button>

            <Button variant="ghost" onClick={props.onBackToMode} disabled={props.busy} class="w-full">
              Back
            </Button>

            <details class="rounded-2xl border border-gray-6 bg-gray-1/60 px-4 py-3">
              <summary class="flex items-center justify-between cursor-pointer text-xs text-gray-10">
                Advanced settings
                <ChevronDown size={14} class="text-gray-7" />
              </summary>
              <div class="pt-3 space-y-3">
                <div class="text-xs text-gray-10">Manage which folders OpenWork can access.</div>

                <div class="space-y-3">
                  <div class="flex gap-2">
                    <input
                      class="w-full bg-gray-2/50 border border-gray-6 rounded-xl px-3 py-2 text-sm text-gray-12 placeholder-gray-7 focus:outline-none focus:ring-1 focus:ring-gray-8 focus:border-gray-8 transition-all"
                      placeholder="Add folder path"
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
                        Pick
                      </Button>
                    </Show>
                    <Button
                      variant="secondary"
                      onClick={props.onAddAuthorizedDir}
                      disabled={!props.newAuthorizedDir.trim()}
                    >
                      Add
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
                              title="Remove"
                            >
                              Remove
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
                        <div class="text-sm font-medium text-gray-12">OpenCode CLI</div>
                        <div class="mt-1 text-xs text-gray-10">
                          <Show when={props.engineDoctorFound != null} fallback={<span>Checking install...</span>}>
                            <Show when={props.engineDoctorFound} fallback={<span>Not found. Install to run Host mode.</span>}>
                              <span class="font-mono">{props.engineDoctorVersion ?? "Installed"}</span>
                              <Show when={props.engineDoctorResolvedPath}>
                                <span class="text-gray-7"> · </span>
                                <span class="font-mono text-gray-7 truncate">{props.engineDoctorResolvedPath}</span>
                              </Show>
                            </Show>
                          </Show>
                        </div>
                      </div>

                      <Button variant="secondary" onClick={props.onRefreshEngineDoctor} disabled={props.busy}>
                        Re-check
                      </Button>
                    </div>

                    <Show when={props.engineDoctorFound === false}>
                      <div class="mt-4 space-y-2">
                        <div class="text-xs text-gray-10">
                          {isWindowsPlatform()
                            ? "Install OpenCode with one of the commands below, then restart OpenWork."
                            : "Install OpenCode from https://opencode.ai/install"}
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
                            Install OpenCode
                          </Button>
                          <Button variant="outline" onClick={props.onShowSearchNotes} disabled={props.busy}>
                            Show search notes
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
                        Last checked {new Date(props.engineDoctorCheckedAt ?? 0).toLocaleTimeString()}
                      </div>
                    </Show>
                  </div>
                </Show>

                <Show when={!engineDoctorAvailable()}>
                  <div class="text-xs text-gray-10">
                    {props.isWindows
                      ? "Install OpenCode for Windows, then restart OpenWork. Ensure opencode.exe is on PATH."
                      : "Install OpenCode to enable host mode (no terminal required)."}
                  </div>
                </Show>

                <Show when={engineDoctorAvailable()}>
                  <div class="text-xs text-gray-7">OpenCode is ready to start in host mode.</div>
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
                        <div class="text-[11px] text-gray-8">Resolved path</div>
                        <div class="font-mono break-all">{props.engineDoctorResolvedPath}</div>
                      </div>
                    </Show>
                    <Show when={props.engineDoctorVersion}>
                      <div>
                        <div class="text-[11px] text-gray-8">Version</div>
                        <div class="font-mono">{props.engineDoctorVersion}</div>
                      </div>
                    </Show>
                    <Show when={props.engineDoctorNotes.length}>
                      <div>
                        <div class="text-[11px] text-gray-8">Search notes</div>
                        <pre class="whitespace-pre-wrap break-words text-xs text-gray-10">
                          {props.engineDoctorNotes.join("\n")}
                        </pre>
                      </div>
                    </Show>
                    <Show when={serveHelpOutput()}>
                      <div>
                        <div class="text-[11px] text-gray-8">serve --help output</div>
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
                  <ArrowLeftRight size={20} class="text-gray-11" />
                </div>
                <h2 class="text-2xl font-bold tracking-tight">Connect to Host</h2>
              <p class="text-gray-11 text-sm leading-relaxed">
                Pair with an existing OpenCode server (LAN or tunnel).
              </p>
            </div>

            <div class="space-y-4">
              <TextInput
                label="Server URL"
                placeholder="http://127.0.0.1:4096"
                value={props.baseUrl}
                onInput={(e) => props.onBaseUrlChange(e.currentTarget.value)}
              />
              <TextInput
                label="Directory (optional)"
                placeholder="/path/to/project"
                value={props.clientDirectory}
                onInput={(e) => props.onClientDirectoryChange(e.currentTarget.value)}
                hint="Use if your host runs multiple workspaces."
              />

              <Button onClick={props.onConnectClient} disabled={props.busy || !props.baseUrl.trim()} class="w-full py-3 text-base">
                Connect
              </Button>

              <Button variant="ghost" onClick={props.onBackToMode} disabled={props.busy} class="w-full">
                Back
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
                <div class="w-12 h-12 rounded-xl flex items-center justify-center">
                  <OpenWorkLogo size={24} class="text-gray-1" />
                </div>
                <h1 class="text-3xl font-bold tracking-tight text-gray-12">OpenWork</h1>
              </div>
              <h2 class="text-xl text-gray-11">How would you like to run OpenWork today?</h2>
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
                  <h3 class="text-xl font-medium text-gray-12 mb-2">Run on this computer</h3>
                  <p class="text-gray-10 text-sm leading-relaxed mb-4">
                    OpenWork runs OpenCode locally and keeps your work private.
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
                    <div class="text-sm text-gray-12 font-medium">Engine already running</div>
                    <div class="text-xs text-gray-10">Attach to the existing session on this device.</div>
                    <Show when={props.developerMode}>
                      <div class="text-xs text-gray-10 font-mono truncate max-w-[14rem] md:max-w-[22rem]">
                        {props.engineBaseUrl}
                      </div>
                    </Show>
                  </div>
                  <Button variant="secondary" onClick={props.onAttachHost} disabled={props.busy}>
                    Attach
                  </Button>
                </div>
              </Show>

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
                  Remember my choice for next time
                </button>
              </div>

              <div class="pt-6 border-t border-gray-6 flex justify-center">
                <button
                  onClick={() => props.onModeSelect("client")}
                  class="text-gray-7 hover:text-gray-11 text-sm font-medium transition-colors flex items-center gap-2 px-4 py-2 rounded-lg hover:bg-gray-2/50"
                >
                  Connect as a Client (Remote Pairing)
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
