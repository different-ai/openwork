import { For, Show } from "solid-js";

import { Folder, FolderPlus, Globe, Loader2, Sparkles, X } from "lucide-solid";
import type { WorkspaceInfo } from "../lib/tauri";
import { t, currentLocale } from "../../i18n";

import Button from "./button";

type SharedSkillSummary = {
  name: string;
  description?: string | null;
  trigger?: string | null;
};

export default function SharedSkillDestinationModal(props: {
  open: boolean;
  skill: SharedSkillSummary | null;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId?: string | null;
  busyWorkspaceId?: string | null;
  onClose: () => void;
  onSelectWorkspace: (workspaceId: string) => void | Promise<void>;
  onCreateWorker?: () => void;
  onConnectRemote?: () => void;
}) {
  const translate = (key: string) => t(key, currentLocale());

  const displayName = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.directory?.trim() ||
    workspace.path?.trim() ||
    workspace.baseUrl?.trim() ||
    "Worker";

  const subtitle = (workspace: WorkspaceInfo) => {
    if (workspace.workspaceType === "local") {
      return workspace.path?.trim() || translate("share_skill_destination.local_badge");
    }
    return (
      workspace.directory?.trim() ||
      workspace.openworkHostUrl?.trim() ||
      workspace.baseUrl?.trim() ||
      workspace.path?.trim() ||
      translate("share_skill_destination.remote_badge")
    );
  };

  const workspaceBadge = (workspace: WorkspaceInfo) => {
    if (
      workspace.workspaceType === "remote" &&
      (workspace.sandboxBackend === "docker" ||
        Boolean(workspace.sandboxRunId?.trim()) ||
        Boolean(workspace.sandboxContainerName?.trim()))
    ) {
      return translate("share_skill_destination.sandbox_badge");
    }
    if (workspace.workspaceType === "remote") {
      return translate("share_skill_destination.remote_badge");
    }
    return translate("share_skill_destination.local_badge");
  };

  const footerBusy = () => Boolean(props.busyWorkspaceId?.trim());

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-1/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
        <div class="bg-gray-2 border border-gray-6 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
          <div class="p-6 border-b border-gray-6 flex justify-between items-center bg-gray-1">
            <div>
              <h3 class="font-semibold text-gray-12 text-lg">{translate("share_skill_destination.title")}</h3>
              <p class="text-gray-10 text-sm">{translate("share_skill_destination.subtitle")}</p>
            </div>
            <button
              onClick={props.onClose}
              disabled={footerBusy()}
              class={`hover:bg-gray-4 p-1 rounded-full ${footerBusy() ? "opacity-50 cursor-not-allowed" : ""}`.trim()}
            >
              <X size={20} class="text-gray-10" />
            </button>
          </div>

          <div class="p-6 flex-1 overflow-y-auto space-y-6">
            <div class="rounded-2xl border border-gray-6 bg-gray-1/40 p-5">
              <div class="flex items-start gap-4">
                <div class="w-11 h-11 shrink-0 rounded-xl bg-indigo-7/10 text-indigo-11 flex items-center justify-center">
                  <Sparkles size={20} />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-[11px] uppercase tracking-[0.22em] font-semibold text-gray-10">
                    {translate("share_skill_destination.skill_label")}
                  </div>
                  <div class="mt-1 text-base font-semibold text-gray-12 break-words">
                    {props.skill?.name ?? translate("share_skill_destination.fallback_skill_name")}
                  </div>
                  <Show when={props.skill?.description?.trim()}>
                    <div class="mt-2 text-sm text-gray-10 leading-relaxed break-words">{props.skill?.description?.trim()}</div>
                  </Show>
                  <Show when={props.skill?.trigger?.trim()}>
                    <div class="mt-3 inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-2 px-3 py-1 text-[11px] text-gray-11">
                      <span class="font-semibold text-gray-12">{translate("share_skill_destination.trigger_label")}</span>
                      <span class="font-mono">{props.skill?.trigger?.trim()}</span>
                    </div>
                  </Show>
                </div>
              </div>
            </div>

            <div class="space-y-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-sm font-medium text-gray-12">{translate("share_skill_destination.existing_workers")}</div>
                <Show when={props.workspaces.length > 0}>
                  <span class="text-[11px] uppercase tracking-[0.18em] text-gray-9">
                    {props.workspaces.length}
                  </span>
                </Show>
              </div>

              <Show
                when={props.workspaces.length > 0}
                fallback={
                  <div class="rounded-xl border border-dashed border-gray-6 bg-gray-1/30 px-4 py-5 text-sm text-gray-10 leading-relaxed">
                    {translate("share_skill_destination.no_workers")}
                  </div>
                }
              >
                <div class="grid gap-3">
                  <For each={props.workspaces}>
                    {(workspace) => {
                      const isActive = () => workspace.id === props.activeWorkspaceId;
                      const isBusy = () => workspace.id === props.busyWorkspaceId;
                      const WorkspaceIcon = () => (workspace.workspaceType === "remote" ? <Globe size={18} /> : <Folder size={18} />);

                      return (
                        <button
                          type="button"
                          onClick={() => void props.onSelectWorkspace(workspace.id)}
                          disabled={footerBusy()}
                          class={`w-full rounded-2xl border p-4 text-left transition-all ${
                            isActive()
                              ? "border-indigo-7/50 bg-indigo-7/10"
                              : "border-gray-6 bg-gray-1/40 hover:border-gray-7 hover:bg-gray-1/70"
                          } ${footerBusy() ? "opacity-70 cursor-wait" : ""}`.trim()}
                        >
                          <div class="flex items-start gap-3">
                            <div
                              class={`mt-0.5 h-10 w-10 shrink-0 rounded-xl flex items-center justify-center ${
                                workspace.workspaceType === "remote"
                                  ? "bg-indigo-7/10 text-indigo-11"
                                  : "bg-amber-7/10 text-amber-11"
                              }`.trim()}
                            >
                              <WorkspaceIcon />
                            </div>
                            <div class="min-w-0 flex-1">
                              <div class="flex flex-wrap items-center gap-2">
                                <div class="text-sm font-medium text-gray-12 break-words">{displayName(workspace)}</div>
                                <Show when={isActive()}>
                                  <span class="rounded-full bg-gray-3 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-gray-11">
                                    {translate("share_skill_destination.current_badge")}
                                  </span>
                                </Show>
                                <span class="rounded-full bg-gray-3 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-gray-11">
                                  {workspaceBadge(workspace)}
                                </span>
                              </div>
                              <div class="mt-1 text-xs text-gray-10 font-mono break-all">{subtitle(workspace)}</div>
                            </div>
                            <Show when={isBusy()}>
                              <div class="shrink-0 pt-1 text-gray-10">
                                <Loader2 size={16} class="animate-spin" />
                              </div>
                            </Show>
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <div class="space-y-3">
              <div class="text-sm font-medium text-gray-12">{translate("share_skill_destination.new_destination")}</div>
              <div class="grid gap-3 md:grid-cols-2">
                <Show when={props.onCreateWorker}>
                  <button
                    type="button"
                    onClick={props.onCreateWorker}
                    disabled={footerBusy()}
                    class={`rounded-2xl border border-gray-6 bg-gray-1/40 p-4 text-left transition-all hover:border-gray-7 hover:bg-gray-1/70 ${footerBusy() ? "opacity-70 cursor-wait" : ""}`.trim()}
                  >
                    <div class="flex items-start gap-3">
                      <div class="h-10 w-10 shrink-0 rounded-xl bg-emerald-7/10 text-emerald-11 flex items-center justify-center">
                        <FolderPlus size={18} />
                      </div>
                      <div>
                        <div class="text-sm font-medium text-gray-12">
                          {translate("share_skill_destination.create_worker")}
                        </div>
                        <div class="mt-1 text-xs text-gray-10 leading-relaxed">
                          {translate("share_skill_destination.create_worker_desc")}
                        </div>
                      </div>
                    </div>
                  </button>
                </Show>

                <Show when={props.onConnectRemote}>
                  <button
                    type="button"
                    onClick={props.onConnectRemote}
                    disabled={footerBusy()}
                    class={`rounded-2xl border border-gray-6 bg-gray-1/40 p-4 text-left transition-all hover:border-gray-7 hover:bg-gray-1/70 ${footerBusy() ? "opacity-70 cursor-wait" : ""}`.trim()}
                  >
                    <div class="flex items-start gap-3">
                      <div class="h-10 w-10 shrink-0 rounded-xl bg-sky-7/10 text-sky-11 flex items-center justify-center">
                        <Globe size={18} />
                      </div>
                      <div>
                        <div class="text-sm font-medium text-gray-12">
                          {translate("share_skill_destination.connect_remote")}
                        </div>
                        <div class="mt-1 text-xs text-gray-10 leading-relaxed">
                          {translate("share_skill_destination.connect_remote_desc")}
                        </div>
                      </div>
                    </div>
                  </button>
                </Show>
              </div>
            </div>
          </div>

          <div class="p-6 border-t border-gray-6 bg-gray-1 flex justify-end">
            <Button variant="ghost" onClick={props.onClose} disabled={footerBusy()}>
              {translate("common.cancel")}
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
