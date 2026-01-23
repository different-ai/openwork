import { Show, createMemo } from "solid-js";
import { Dynamic } from "solid-js/web";

import { Folder, Globe, Loader2, Zap } from "lucide-solid";
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
      <div class="fixed inset-0 z-[60] flex items-center justify-center bg-gray-1/60 backdrop-blur-sm p-6 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200">
        <div class="w-full max-w-md rounded-2xl bg-gray-2 border border-gray-6 shadow-2xl p-6">
          <div class="flex items-start gap-4">
            <div class="w-12 h-12 rounded-2xl bg-gray-3 flex items-center justify-center text-gray-12">
              <Dynamic component={Icon()} size={22} />
            </div>
            <div class="flex-1 min-w-0 space-y-3">
              <div class="space-y-1">
                <div class="flex items-center gap-2">
                  <h3 class="text-lg font-medium text-gray-12 truncate">{title()}</h3>
                  <Show when={props.workspace?.workspaceType === "remote"}>
                    <span class="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-gray-4 text-gray-11">
                      {translate("dashboard.remote")}
                    </span>
                  </Show>
                </div>
                <p class="text-sm text-gray-11">{subtitle()}</p>
              </div>
              <div class="min-h-[1rem] flex items-center gap-2 text-xs text-gray-10">
                <Loader2
                  size={14}
                  class="text-gray-10 motion-safe:animate-spin motion-reduce:opacity-60"
                  style={{ "animation-duration": "1.6s" }}
                />
                <span>{statusLine()}</span>
              </div>
              <Show when={metaPrimary()}>
                <div class="text-[11px] text-gray-9 font-mono truncate">{metaPrimary()}</div>
              </Show>
              <Show when={metaSecondary()}>
                <div class="text-[11px] text-gray-8 font-mono truncate">{metaSecondary()}</div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
