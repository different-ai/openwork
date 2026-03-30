import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { CheckCircle2, Folder, FolderPlus, Globe, Loader2, Sparkles, X } from "lucide-solid";
import type { WorkspaceInfo } from "../lib/tauri";
import { t, currentLocale } from "../../i18n";

import Button from "../components/button";

type SkillSummary = {
  name: string;
  description?: string | null;
  trigger?: string | null;
};

export default function SkillDestinationModal(props: {
  open: boolean;
  skill: SkillSummary | null;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId?: string | null;
  busyWorkspaceId?: string | null;
  onClose: () => void;
  onSubmitWorkspace: (workspaceId: string) => void | Promise<void>;
  onCreateWorker?: () => void;
  onConnectRemote?: () => void;
}) {
  const translate = (key: string) => t(key, currentLocale());
  const [selectedWorkspaceId, setSelectedWorkspaceId] = createSignal<string | null>(null);

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
  const selectedWorkspace = createMemo(() => props.workspaces.find((workspace) => workspace.id === selectedWorkspaceId()) ?? null);

  createEffect(() => {
    if (!props.open) return;
    const activeMatch = props.workspaces.find((workspace) => workspace.id === props.selectedWorkspaceId) ?? props.workspaces[0] ?? null;
    setSelectedWorkspaceId(activeMatch?.id ?? null);
  });

  const submitSelectedWorkspace = () => {
    const workspaceId = selectedWorkspaceId()?.trim();
    if (!workspaceId || footerBusy()) return;
    void props.onSubmitWorkspace(workspaceId);
  };

  const isSandboxWorkspace = (workspace: WorkspaceInfo) =>
    workspace.workspaceType === "remote" &&
    (workspace.sandboxBackend === "docker" ||
      Boolean(workspace.sandboxRunId?.trim()) ||
      Boolean(workspace.sandboxContainerName?.trim()));

  const workspaceCircleClass = (workspace: WorkspaceInfo, selected: boolean) => {
    if (selected) {
      return "bg-indigo-7/15 text-indigo-11 border border-indigo-7/30";
    }
    if (isSandboxWorkspace(workspace)) {
      return "bg-indigo-7/10 text-indigo-11 border border-indigo-7/20";
    }
    if (workspace.workspaceType === "remote") {
      return "bg-sky-7/10 text-sky-11 border border-sky-7/20";
    }
    return "bg-amber-7/10 text-amber-11 border border-amber-7/20";
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-12/40 p-4 backdrop-blur-sm animate-in fade-in duration-200">
        <div class="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-6 bg-gray-1 shadow-2xl">
          <div class="border-b border-gray-6 bg-gray-1 px-6 py-5">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0 space-y-3">
                <div class="inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-10">
                  <Sparkles size={12} />
                  {translate("share_skill_destination.skill_label")}
                </div>
                <div class="rounded-xl border border-gray-6 bg-gray-2/40 px-4 py-4">
                  <div class="flex items-start gap-3">
                    <div class="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-indigo-7/20 bg-indigo-7/10 text-indigo-11">
                      <Sparkles size={17} />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-9">
                        {translate("share_skill_destination.skill_label")}
                      </div>
                      <h3 class="mt-1 text-lg font-semibold text-gray-12 break-words">
                        {props.skill?.name ?? translate("share_skill_destination.fallback_skill_name")}
                      </h3>
                      <Show when={props.skill?.description?.trim()}>
                        <p class="mt-1 text-sm leading-relaxed text-gray-10 break-words">{props.skill?.description?.trim()}</p>
                      </Show>
                      <Show when={props.skill?.trigger?.trim()}>
                        <div class="mt-3 inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-1 px-3 py-1 text-[11px] text-gray-10">
                          <span class="font-semibold text-gray-12">{translate("share_skill_destination.trigger_label")}</span>
                          <span class="font-mono">{props.skill?.trigger?.trim()}</span>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
                <div>
                  <h4 class="text-sm font-medium text-gray-12">{translate("share_skill_destination.title")}</h4>
                  <p class="mt-1 text-sm leading-relaxed text-gray-10">{translate("share_skill_destination.subtitle")}</p>
                </div>
              </div>

              <button
                onClick={props.onClose}
                disabled={footerBusy()}
                class={`rounded-full p-2 text-gray-9 transition hover:bg-gray-2 hover:text-gray-12 ${footerBusy() ? "cursor-not-allowed opacity-50" : ""}`.trim()}
                aria-label={translate("common.close")}
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div class="flex-1 space-y-5 overflow-y-auto px-6 py-5">
            <div class="space-y-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-sm font-medium text-gray-12">{translate("share_skill_destination.existing_workers")}</div>
                <Show when={props.workspaces.length > 0}>
                  <span class="text-[11px] uppercase tracking-[0.18em] text-gray-9">{props.workspaces.length}</span>
                </Show>
              </div>

              <Show
                when={props.workspaces.length > 0}
                fallback={
                  <div class="rounded-xl border border-dashed border-gray-6 bg-gray-2/20 px-4 py-5 text-sm leading-relaxed text-gray-10">
                    {translate("share_skill_destination.no_workers")}
                  </div>
                }
              >
                <div class="space-y-2">
                  <For each={props.workspaces}>
                    {(workspace) => {
                      const isActive = () => workspace.id === props.selectedWorkspaceId;
                      const isSelected = () => workspace.id === selectedWorkspaceId();
                      const isBusy = () => workspace.id === props.busyWorkspaceId;
                      const WorkspaceIcon = () => (workspace.workspaceType === "remote" ? <Globe size={16} /> : <Folder size={16} />);

                      return (
                        <button
                          type="button"
                          onClick={() => setSelectedWorkspaceId(workspace.id)}
                          disabled={footerBusy()}
                          aria-pressed={isSelected()}
                          class={`w-full rounded-xl border text-left transition-colors ${
                            isSelected()
                              ? "border-indigo-7/40 bg-indigo-2/20"
                              : "border-gray-6/40 bg-transparent hover:border-gray-7/50 hover:bg-gray-2"
                          } ${footerBusy() ? "cursor-wait opacity-70" : ""}`.trim()}
                        >
                          <div class="flex items-start gap-3 px-4 py-3">
                            <div class={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${workspaceCircleClass(workspace, isSelected())}`.trim()}>
                              <WorkspaceIcon />
                            </div>

                            <div class="min-w-0 flex-1">
                              <div class="flex flex-wrap items-center gap-2">
                                <div class="text-sm font-semibold text-gray-12 break-words">{displayName(workspace)}</div>
                                <Show when={isActive()}>
                                  <span class="rounded-full bg-gray-3 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-gray-11">
                                    {translate("share_skill_destination.current_badge")}
                                  </span>
                                </Show>
                                <span class="rounded-full bg-gray-3 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-gray-11">
                                  {workspaceBadge(workspace)}
                                </span>
                                <Show when={isSelected()}>
                                  <span class="rounded-full bg-indigo-3/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-indigo-11">
                                    {translate("share_skill_destination.selected_badge")}
                                  </span>
                                </Show>
                              </div>

                              <div class="mt-1 text-[11px] font-mono break-all text-gray-8/80">{subtitle(workspace)}</div>
                              <Show when={isSelected()}>
                                <div class="mt-2 text-xs font-medium text-gray-11">{translate("share_skill_destination.selected_hint")}</div>
                              </Show>
                            </div>

                            <div class="shrink-0 pt-0.5 text-gray-9">
                              <Show when={isBusy()} fallback={<CheckCircle2 size={16} class={isSelected() ? "text-indigo-11" : "text-gray-7"} />}>
                                <Loader2 size={16} class="animate-spin" />
                              </Show>
                            </div>
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <Show when={props.onCreateWorker || props.onConnectRemote}>
              <div class="space-y-3 border-t border-gray-6 pt-5">
                <div class="text-sm font-medium text-gray-12">{translate("share_skill_destination.more_options")}</div>
                <div class="grid gap-3 md:grid-cols-2">
                  <Show when={props.onCreateWorker}>
                    <button
                      type="button"
                      onClick={() => props.onCreateWorker?.()}
                      disabled={footerBusy()}
                      class={`rounded-xl border border-indigo-7/30 bg-indigo-7/10 px-4 py-4 text-left transition hover:border-indigo-7/50 hover:bg-indigo-7/15 ${footerBusy() ? "cursor-not-allowed opacity-60" : ""}`.trim()}
                    >
                      <div class="flex items-start gap-3">
                        <div class="mt-0.5 flex h-10 w-10 items-center justify-center rounded-full border border-indigo-7/30 bg-indigo-7/15 text-indigo-11">
                          <FolderPlus size={17} />
                        </div>
                        <div>
                          <div class="text-sm font-semibold text-gray-12">{translate("share_skill_destination.create_worker")}</div>
                          <div class="mt-1 text-sm text-gray-10">{translate("share_skill_destination.create_worker_hint")}</div>
                        </div>
                      </div>
                    </button>
                  </Show>

                  <Show when={props.onConnectRemote}>
                    <button
                      type="button"
                      onClick={() => props.onConnectRemote?.()}
                      disabled={footerBusy()}
                      class={`rounded-xl border border-sky-7/30 bg-sky-7/10 px-4 py-4 text-left transition hover:border-sky-7/50 hover:bg-sky-7/15 ${footerBusy() ? "cursor-not-allowed opacity-60" : ""}`.trim()}
                    >
                      <div class="flex items-start gap-3">
                        <div class="mt-0.5 flex h-10 w-10 items-center justify-center rounded-full border border-sky-7/30 bg-sky-7/15 text-sky-11">
                          <Globe size={17} />
                        </div>
                        <div>
                          <div class="text-sm font-semibold text-gray-12">{translate("share_skill_destination.connect_remote")}</div>
                          <div class="mt-1 text-sm text-gray-10">{translate("share_skill_destination.connect_remote_hint")}</div>
                        </div>
                      </div>
                    </button>
                  </Show>
                </div>
              </div>
            </Show>
          </div>

          <div class="border-t border-gray-6 bg-gray-1 px-6 py-4">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Show when={selectedWorkspace()}>
                {(workspace) => (
                  <div class="min-w-0 text-sm text-gray-10">
                    <span class="font-medium text-gray-12">{displayName(workspace())}</span>
                    <span class="mx-2 text-gray-8">·</span>
                    <span class="truncate align-middle">{subtitle(workspace())}</span>
                  </div>
                )}
              </Show>

              <div class="flex items-center justify-end gap-3">
                <Button variant="ghost" onClick={props.onClose} disabled={footerBusy()}>
                  {translate("common.cancel")}
                </Button>
                <Button variant="primary" onClick={submitSelectedWorkspace} disabled={!selectedWorkspace() || footerBusy()}>
                  <Show when={footerBusy()} fallback={translate("share_skill_destination.add_to_workspace")}>
                    <span class="inline-flex items-center gap-2">
                      <Loader2 size={16} class="animate-spin" />
                      {translate("share_skill_destination.adding")}
                    </span>
                  </Show>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
