import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { CheckCircle2, Folder, FolderPlus, Globe, Loader2, Sparkles, X } from "lucide-solid";
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
    const activeMatch = props.workspaces.find((workspace) => workspace.id === props.activeWorkspaceId) ?? props.workspaces[0] ?? null;
    setSelectedWorkspaceId(activeMatch?.id ?? null);
  });

  const submitSelectedWorkspace = () => {
    const workspaceId = selectedWorkspaceId()?.trim();
    if (!workspaceId || footerBusy()) return;
    void props.onSubmitWorkspace(workspaceId);
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-[#edf2f7]/72 p-4 backdrop-blur-md animate-in fade-in duration-200">
        <div class="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-[2rem] border border-white/70 bg-[rgba(255,255,255,0.88)] shadow-[0_30px_90px_-34px_rgba(15,23,42,0.28)]">
          <div class="border-b border-slate-200/70 bg-white/70 px-6 py-6">
            <div class="flex items-start justify-between gap-4">
              <div class="space-y-2">
                <div class="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
                  <Sparkles size={12} />
                  Shared skill
                </div>
                <div>
                  <h3 class="text-xl font-semibold text-slate-950">{translate("share_skill_destination.title")}</h3>
                  <p class="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">{translate("share_skill_destination.subtitle")}</p>
                </div>
              </div>
              <button
                onClick={props.onClose}
                disabled={footerBusy()}
                class={`rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 ${footerBusy() ? "cursor-not-allowed opacity-50" : ""}`.trim()}
                aria-label={translate("common.close")}
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div class="flex-1 space-y-6 overflow-y-auto px-6 py-6">
            <div class="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(17rem,0.85fr)]">
              <div class="rounded-[1.75rem] border border-white/80 bg-white/80 p-5 shadow-[0_20px_50px_-32px_rgba(15,23,42,0.22)]">
                <div class="flex items-start gap-4">
                  <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-indigo-200/80 bg-indigo-50 text-indigo-700">
                    <Sparkles size={20} />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                      {translate("share_skill_destination.skill_label")}
                    </div>
                    <div class="mt-2 text-lg font-semibold text-slate-950 break-words">
                      {props.skill?.name ?? translate("share_skill_destination.fallback_skill_name")}
                    </div>
                    <Show when={props.skill?.description?.trim()}>
                      <div class="mt-2 text-sm leading-relaxed text-slate-600 break-words">{props.skill?.description?.trim()}</div>
                    </Show>
                    <Show when={props.skill?.trigger?.trim()}>
                      <div class="mt-4 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] text-slate-700">
                        <span class="font-semibold text-slate-950">{translate("share_skill_destination.trigger_label")}</span>
                        <span class="font-mono">{props.skill?.trigger?.trim()}</span>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>

              <div class="rounded-[1.75rem] border border-slate-200/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,0.82))] p-5 shadow-[0_20px_50px_-34px_rgba(15,23,42,0.2)]">
                <div class="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Ready to add</div>
                <Show
                  when={selectedWorkspace()}
                  fallback={<p class="mt-3 text-sm leading-relaxed text-slate-600">Select a worker, then confirm to add this skill.</p>}
                >
                  {(workspace) => (
                    <>
                      <div class="mt-3 text-lg font-semibold text-slate-950 break-words">{displayName(workspace())}</div>
                      <div class="mt-2 text-sm break-all text-slate-600">{subtitle(workspace())}</div>
                      <div class="mt-4 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
                        <CheckCircle2 size={12} />
                        {translate("share_skill_destination.selection_ready")}
                      </div>
                    </>
                  )}
                </Show>
              </div>
            </div>

            <div class="space-y-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-sm font-medium text-slate-950">{translate("share_skill_destination.existing_workers")}</div>
                <Show when={props.workspaces.length > 0}>
                  <span class="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                    {props.workspaces.length}
                  </span>
                </Show>
              </div>

              <Show
                when={props.workspaces.length > 0}
                fallback={
                  <div class="rounded-[1.5rem] border border-dashed border-slate-300 bg-white/65 px-4 py-5 text-sm leading-relaxed text-slate-600">
                    {translate("share_skill_destination.no_workers")}
                  </div>
                }
              >
                <div class="grid gap-3">
                  <For each={props.workspaces}>
                    {(workspace) => {
                      const isActive = () => workspace.id === props.activeWorkspaceId;
                      const isSelected = () => workspace.id === selectedWorkspaceId();
                      const isBusy = () => workspace.id === props.busyWorkspaceId;
                      const WorkspaceIcon = () => (workspace.workspaceType === "remote" ? <Globe size={18} /> : <Folder size={18} />);

                      return (
                        <button
                          type="button"
                          onClick={() => setSelectedWorkspaceId(workspace.id)}
                          disabled={footerBusy()}
                          aria-pressed={isSelected()}
                          class={`w-full rounded-[1.5rem] border p-4 text-left transition-all duration-200 ${
                            isSelected()
                              ? "border-slate-900 bg-slate-950/[0.04] shadow-[0_18px_45px_-34px_rgba(15,23,42,0.35)]"
                              : "border-slate-200/80 bg-white/78 hover:-translate-y-[1px] hover:border-slate-300 hover:bg-white"
                          } ${footerBusy() ? "cursor-wait opacity-70" : ""}`.trim()}
                        >
                          <div class="flex items-start gap-3">
                            <div
                              class={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border ${
                                isSelected()
                                  ? "border-slate-300 bg-slate-950 text-white"
                                  : workspace.workspaceType === "remote"
                                    ? "border-sky-200 bg-sky-50 text-sky-700"
                                    : "border-amber-200 bg-amber-50 text-amber-700"
                              }`.trim()}
                            >
                              <WorkspaceIcon />
                            </div>
                            <div class="min-w-0 flex-1">
                              <div class="flex flex-wrap items-center gap-2">
                                <div class="text-sm font-medium text-slate-950 break-words">{displayName(workspace)}</div>
                                <Show when={isActive()}>
                                  <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-700">
                                    {translate("share_skill_destination.current_badge")}
                                  </span>
                                </Show>
                                <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-700">
                                  {workspaceBadge(workspace)}
                                </span>
                              </div>
                              <div class="mt-1 text-xs font-mono break-all text-slate-500">{subtitle(workspace)}</div>
                              <Show when={isSelected()}>
                                <div class="mt-3 text-xs font-medium text-slate-700">{translate("share_skill_destination.selected_hint")}</div>
                              </Show>
                            </div>
                            <Show when={isBusy()}>
                              <div class="shrink-0 pt-1 text-slate-500">
                                <Loader2 size={16} class="animate-spin" />
                              </div>
                            </Show>
                            <Show when={!isBusy()}>
                              <div class="mt-0.5 shrink-0">
                                <div
                                  class={`flex h-6 w-6 items-center justify-center rounded-full border transition-colors ${
                                    isSelected()
                                      ? "border-slate-900 bg-slate-900 text-white"
                                      : "border-slate-300 bg-white text-transparent"
                                  }`.trim()}
                                >
                                  <CheckCircle2 size={14} />
                                </div>
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
              <div class="text-sm font-medium text-slate-950">{translate("share_skill_destination.new_destination")}</div>
              <div class="grid gap-3 md:grid-cols-2">
                <Show when={props.onCreateWorker}>
                  <button
                    type="button"
                    onClick={props.onCreateWorker}
                    disabled={footerBusy()}
                    class={`rounded-[1.5rem] border border-slate-200/80 bg-white/75 p-4 text-left transition-all hover:-translate-y-[1px] hover:border-slate-300 hover:bg-white ${footerBusy() ? "cursor-wait opacity-70" : ""}`.trim()}
                  >
                    <div class="flex items-start gap-3">
                      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-emerald-200 bg-emerald-50 text-emerald-700">
                        <FolderPlus size={18} />
                      </div>
                      <div>
                        <div class="text-sm font-medium text-slate-950">
                          {translate("share_skill_destination.create_worker")}
                        </div>
                        <div class="mt-1 text-xs leading-relaxed text-slate-600">
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
                    class={`rounded-[1.5rem] border border-slate-200/80 bg-white/75 p-4 text-left transition-all hover:-translate-y-[1px] hover:border-slate-300 hover:bg-white ${footerBusy() ? "cursor-wait opacity-70" : ""}`.trim()}
                  >
                    <div class="flex items-start gap-3">
                      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-sky-200 bg-sky-50 text-sky-700">
                        <Globe size={18} />
                      </div>
                      <div>
                        <div class="text-sm font-medium text-slate-950">
                          {translate("share_skill_destination.connect_remote")}
                        </div>
                        <div class="mt-1 text-xs leading-relaxed text-slate-600">
                          {translate("share_skill_destination.connect_remote_desc")}
                        </div>
                      </div>
                    </div>
                  </button>
                </Show>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-3 border-t border-slate-200/70 bg-white/75 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div class="text-sm text-slate-600">
              <Show
                when={selectedWorkspace()}
                fallback={<span>{translate("share_skill_destination.footer_idle")}</span>}
              >
                {(workspace) => (
                  <span>
                    {translate("share_skill_destination.footer_selected")} <span class="font-medium text-slate-950">{displayName(workspace())}</span>
                  </span>
                )}
              </Show>
            </div>

            <div class="flex items-center justify-end gap-2">
              <Button variant="ghost" class="rounded-full px-4" onClick={props.onClose} disabled={footerBusy()}>
                {translate("common.cancel")}
              </Button>
              <Button
                variant="primary"
                class="rounded-full px-4"
                onClick={submitSelectedWorkspace}
                disabled={!selectedWorkspaceId() || footerBusy()}
              >
                <Show when={footerBusy()} fallback={translate("share_skill_destination.confirm_button")}>
                  <>
                    <Loader2 size={15} class="animate-spin" />
                    {translate("share_skill_destination.confirm_busy")}
                  </>
                </Show>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
