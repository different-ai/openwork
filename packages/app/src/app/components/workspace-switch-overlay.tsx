import { Show, createMemo } from "solid-js";
import { Dynamic } from "solid-js/web";

import { Folder, Globe, Zap } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import type { WorkspaceInfo } from "../lib/tauri";

function iconForWorkspace(preset: string, workspaceType: string) {
  if (workspaceType === "remote") return Globe;
  if (preset === "starter") return Zap;
  if (preset === "automation") return Folder;
  if (preset === "minimal") return Globe;
  return Folder;
}

export default function WorkspaceSwitchOverlay(props: {
  open: boolean;
  workspace: WorkspaceInfo | null;
  statusKey: string;
}) {
  const translate = (key: string) => t(key, currentLocale());

  const workspaceName = createMemo(() => {
    if (!props.workspace) return "";
    return (
      props.workspace.displayName?.trim() ||
      props.workspace.name?.trim() ||
      props.workspace.baseUrl?.trim() ||
      props.workspace.path?.trim() ||
      ""
    );
  });

  const title = createMemo(() => {
    const name = workspaceName();
    if (!name) return translate("workspace.switching_title_unknown");
    return translate("workspace.switching_title").replace("{name}", name);
  });

  const subtitle = createMemo(() => translate("workspace.switching_subtitle"));

  const statusLine = createMemo(() => {
    if (props.statusKey) return translate(props.statusKey);
    return translate("workspace.switching_status_loading");
  });

  const metaPrimary = createMemo(() => {
    if (!props.workspace) return "";
    if (props.workspace.workspaceType === "remote") {
      return props.workspace.baseUrl?.trim() ?? "";
    }
    return props.workspace.path?.trim() ?? "";
  });

  const metaSecondary = createMemo(() => {
    if (!props.workspace || props.workspace.workspaceType !== "remote") return "";
    return props.workspace.directory?.trim() ?? "";
  });

  const Icon = createMemo(() =>
    iconForWorkspace(props.workspace?.preset ?? "starter", props.workspace?.workspaceType ?? "local")
  );

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[60] overflow-hidden bg-gray-1 text-gray-12 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
        <div class="absolute inset-0">
          <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-gray-2 via-gray-1 to-gray-1 opacity-80" />
          <div
            class="absolute -top-24 right-[-4rem] h-72 w-72 rounded-full bg-indigo-7/20 blur-3xl motion-safe:animate-pulse motion-reduce:opacity-40"
            style={{ "animation-duration": "6s" }}
          />
          <div
            class="absolute -bottom-28 left-[-5rem] h-80 w-80 rounded-full bg-indigo-6/15 blur-3xl motion-safe:animate-pulse motion-reduce:opacity-40"
            style={{ "animation-duration": "8s" }}
          />
          <div class="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-gray-1 via-gray-1/40 to-transparent" />
        </div>

        <div class="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-10 text-center">
          <div class="flex flex-col items-center gap-8">
            <div class="flex items-center gap-3 text-[10px] uppercase tracking-[0.35em] text-gray-8">
              <span class="h-px w-10 bg-gray-6/60" />
              <span>OpenWork</span>
              <span class="h-px w-10 bg-gray-6/60" />
            </div>

            <div class="relative">
              <div
                class="absolute inset-0 rounded-full bg-indigo-6/20 blur-2xl motion-safe:animate-pulse motion-reduce:opacity-50"
                style={{ "animation-duration": "5s" }}
              />
              <div
                class="absolute -inset-4 rounded-full border border-gray-6/40 motion-safe:animate-spin motion-reduce:opacity-60"
                style={{ "animation-duration": "14s" }}
              />
              <div
                class="absolute -inset-1 rounded-full border border-gray-6/30 motion-safe:animate-spin motion-reduce:opacity-60"
                style={{ "animation-duration": "9s", "animation-direction": "reverse" }}
              />
              <div class="relative h-24 w-24 rounded-3xl bg-gray-2/80 border border-gray-6/70 shadow-2xl flex items-center justify-center text-gray-12">
                <Dynamic component={Icon()} size={26} />
              </div>
            </div>

            <div class="space-y-2">
              <div class="flex items-center justify-center gap-2">
                <h2 class="text-2xl font-semibold tracking-tight">{title()}</h2>
                <Show when={props.workspace?.workspaceType === "remote"}>
                  <span class="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-gray-4 text-gray-11">
                    {translate("dashboard.remote")}
                  </span>
                </Show>
              </div>
              <p class="text-sm text-gray-10">{subtitle()}</p>
            </div>

            <div class="flex flex-col items-center gap-3">
              <div class="flex items-center gap-2 text-sm text-gray-11">
                <span class="relative flex h-2.5 w-2.5">
                  <span
                    class="absolute inline-flex h-full w-full rounded-full bg-indigo-7/40 motion-safe:animate-ping motion-reduce:opacity-40"
                    style={{ "animation-duration": "2.6s" }}
                  />
                  <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-indigo-7/70" />
                </span>
                <span>{statusLine()}</span>
              </div>
              <div class="h-1 w-56 overflow-hidden rounded-full bg-gray-4/50">
                <div
                  class="h-full w-1/2 rounded-full bg-gradient-to-r from-transparent via-indigo-6/50 to-transparent motion-safe:animate-pulse motion-reduce:opacity-70"
                  style={{ "animation-duration": "2.8s" }}
                />
              </div>
            </div>

            <div class="space-y-1 text-[11px] text-gray-8 font-mono">
              <Show when={metaPrimary()}>
                <div class="truncate max-w-[22rem]">{metaPrimary()}</div>
              </Show>
              <Show when={metaSecondary()}>
                <div class="truncate max-w-[22rem] text-gray-7">{metaSecondary()}</div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
