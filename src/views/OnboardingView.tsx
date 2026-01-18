import { For, Match, Show, Switch } from "solid-js";
import type { Mode, OnboardingStep } from "../app/types";
import { isTauriRuntime, isWindowsPlatform } from "../app/utils";
import { ArrowLeftRight, CheckCircle2, Circle, ChevronDown } from "lucide-solid";

import Button from "../components/Button";
import OpenWorkLogo from "../components/OpenWorkLogo";
import TextInput from "../components/TextInput";

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
  localHostLabel: string;
  engineRunning: boolean;
  engineBaseUrl: string | null;
  engineDoctorFound: boolean | null;
  engineDoctorSupportsServe: boolean | null;
  engineDoctorVersion: string | null;
  engineDoctorResolvedPath: string | null;
  engineDoctorNotes: string[];
  engineDoctorCheckedAt: number | null;
  engineInstallLogs: string | null;
  error: string | null;
  developerMode: boolean;
  onBaseUrlChange: (value: string) => void;
  onClientDirectoryChange: (value: string) => void;
  onModeSelect: (mode: Mode) => void;
  onRememberModeToggle: () => void;
  onStartHost: () => void;
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
  const engineDoctorAvailable = () => props.engineDoctorFound !== false && props.engineDoctorSupportsServe !== false;

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
                {props.mode === "host" ? "Starting OpenWork..." : "Searching for Host..."}
              </h2>
              <p class="text-zinc-500 text-sm">
                {props.mode === "host"
                  ? "Getting everything ready"
                  : "Verifying secure handshake"}
              </p>

            </div>
          </div>
        </div>
      </Match>

      <Match when={props.onboardingStep === "host"}>
        <div class="min-h-screen flex flex-col items-center justify-center bg-black text-white p-6 relative">
          <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-900 to-transparent opacity-20 pointer-events-none" />

          <div class="max-w-md w-full z-10 space-y-8">
            <div class="text-center space-y-2">
              <div class="w-12 h-12 bg-white rounded-2xl mx-auto flex items-center justify-center shadow-2xl shadow-white/10 mb-6">
                <OpenWorkLogo size={18} class="text-black" />
              </div>
              <h2 class="text-2xl font-bold tracking-tight">Create your first workspace</h2>
              <p class="text-zinc-400 text-sm leading-relaxed">
                A workspace is a <span class="font-semibold text-white">folder</span> with its own skills, plugins, and templates.
              </p>
            </div>

             <div class="space-y-4">
               <div class="bg-zinc-900/30 border border-zinc-800/60 rounded-2xl p-5 space-y-3">
                 <div class="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Workspace</div>
 
                 <div class="space-y-2">
                   <div class="text-sm font-medium text-white">Starter Workspace</div>
                   <div class="text-xs text-zinc-500">
                     OpenWork will create a ready-to-run folder and start OpenCode inside it.
                   </div>
                  <div class={`text-xs ${props.developerMode ? "text-zinc-600 font-mono" : "text-zinc-500"} break-all`}>
                    {props.developerMode ? props.activeWorkspacePath || "(initializing...)" : "A starter workspace will be created for you."}
                  </div>

                 </div>
 
                 <div class="pt-3 border-t border-zinc-800/60 space-y-2">
                   <div class="text-xs font-semibold text-zinc-500 uppercase tracking-wider">What you get</div>
                   <div class="space-y-2">
                     <div class="flex items-center gap-3 text-sm text-zinc-300">
                       <div class="w-2 h-2 rounded-full bg-emerald-500" />
                       Scheduler plugin (workspace-scoped)
                     </div>
                     <div class="flex items-center gap-3 text-sm text-zinc-300">
                       <div class="w-2 h-2 rounded-full bg-emerald-500" />
                       Starter templates ("Understand this workspace", etc.)
                     </div>
                     <div class="flex items-center gap-3 text-sm text-zinc-300">
                       <div class="w-2 h-2 rounded-full bg-emerald-500" />
                       You can add more folders when prompted
                     </div>
                   </div>
                 </div>
               </div>
 
               <Button onClick={props.onStartHost} disabled={props.busy || !props.activeWorkspacePath.trim()} class="w-full py-3 text-base">
                 Start Workspace
               </Button>
 
               <details class="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
                 <summary class="flex items-center justify-between cursor-pointer text-xs text-zinc-500">
                   Advanced settings
                   <ChevronDown size={14} class="text-zinc-600" />
                 </summary>
                 <div class="pt-3 space-y-3">
                   <div class="text-xs text-zinc-600">
                     Authorized folders live in <span class="font-mono">.opencode/openwork.json</span> and can be updated here anytime.
                   </div>
 
                   <div class="space-y-3">
                     <div class="flex gap-2">
                       <input
                         class="w-full bg-zinc-900/50 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:border-zinc-600 transition-all"
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
                         <Button variant="outline" onClick={props.onAddAuthorizedDirFromPicker} disabled={props.busy}>
                           Pick
                         </Button>
                       </Show>
                       <Button variant="secondary" onClick={props.onAddAuthorizedDir} disabled={!props.newAuthorizedDir.trim()}>
                         Add
                       </Button>
                     </div>
 
                     <Show when={props.authorizedDirs.length}>
                       <div class="space-y-2">
                         <For each={props.authorizedDirs}>
                           {(dir, idx) => (
                             <div class="flex items-center justify-between gap-3 rounded-xl bg-black/20 border border-zinc-800 px-3 py-2">
                               <div class="min-w-0 text-xs font-mono text-zinc-300 truncate">{dir}</div>
                               <Button
                                 variant="ghost"
                                 class="!p-2 rounded-lg text-xs text-zinc-400 hover:text-white"
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
                     <div class="rounded-2xl bg-zinc-900/40 border border-zinc-800 p-4">
                       <div class="flex items-start justify-between gap-4">
                         <div class="min-w-0">
                           <div class="text-sm font-medium text-white">OpenCode CLI</div>
                           <div class="mt-1 text-xs text-zinc-500">
                             <Show when={props.engineDoctorFound != null} fallback={<span>Checking install...</span>}>
                               <Show when={props.engineDoctorFound} fallback={<span>Not found. Install to run Host mode.</span>}>
                                 <span class="font-mono">{props.engineDoctorVersion ?? "Installed"}</span>
                                 <Show when={props.engineDoctorResolvedPath}>
                                   <span class="text-zinc-600"> · </span>
                                   <span class="font-mono text-zinc-600 truncate">{props.engineDoctorResolvedPath}</span>
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
                           <div class="text-xs text-zinc-500">
                             {isWindowsPlatform()
                               ? "Install OpenCode with one of the commands below, then restart OpenWork."
                               : "Install OpenCode from https://opencode.ai/install"}
                           </div>
                           <Show when={isWindowsPlatform()}>
                             <div class="text-xs text-zinc-500 space-y-1 font-mono">
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
                         <pre class="mt-4 max-h-48 overflow-auto rounded-xl bg-black/50 border border-zinc-800 p-3 text-xs text-zinc-300 whitespace-pre-wrap">{props.engineInstallLogs}</pre>
                       </Show>
 
                       <Show when={props.engineDoctorCheckedAt}>
                         <div class="mt-3 text-[11px] text-zinc-600">
                           Last checked {props.engineDoctorCheckedAt ? new Date(props.engineDoctorCheckedAt).toLocaleTimeString() : ""}
                         </div>
                       </Show>
                     </div>
                   </Show>
                 </div>
               </details>
 
               <Button variant="ghost" onClick={props.onBackToMode} disabled={props.busy} class="w-full">
                 Back
               </Button>
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
                <h2 class="text-2xl font-bold tracking-tight">Connect to Host</h2>
              <p class="text-zinc-400 text-sm leading-relaxed">
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
              <h2 class="text-xl text-zinc-400 font-light">How would you like to run OpenWork today?</h2>
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
                  <h3 class="text-xl font-medium text-white mb-2">Run on this computer</h3>
                  <p class="text-zinc-500 text-sm leading-relaxed mb-4">
                    OpenWork runs OpenCode locally and keeps your work private.
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
                    <div class="text-sm text-white font-medium">Engine already running</div>
                    <Show when={props.developerMode}>
                      <div class="text-xs text-zinc-500 font-mono truncate max-w-[14rem] md:max-w-[22rem]">
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
                  Remember my choice for next time
                </button>
              </div>

              <div class="pt-6 border-t border-zinc-900 flex justify-center">
                <button
                  onClick={() => props.onModeSelect("client")}
                  class="text-zinc-600 hover:text-zinc-400 text-sm font-medium transition-colors flex items-center gap-2 px-4 py-2 rounded-lg hover:bg-zinc-900/50"
                >
                  Connect as a Client (Remote Pairing)
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
