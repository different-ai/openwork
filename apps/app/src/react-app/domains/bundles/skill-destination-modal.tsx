/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Folder,
  FolderPlus,
  Globe,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";

import type { WorkspaceInfo } from "../../../app/lib/tauri";
import { currentLocale, t } from "../../../i18n";
import { isSandboxWorkspace } from "../../../app/utils";
import { Button } from "../../design-system/button";

type SkillSummary = {
  name: string;
  description?: string | null;
  trigger?: string | null;
};

export type SkillDestinationModalProps = {
  open: boolean;
  skill: SkillSummary | null;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId?: string | null;
  busyWorkspaceId?: string | null;
  onClose: () => void;
  onSubmitWorkspace: (workspaceId: string) => void | Promise<void>;
  onCreateWorker?: () => void;
  onConnectRemote?: () => void;
};

const displayName = (workspace: WorkspaceInfo, fallback: string): string =>
  workspace.displayName?.trim() ||
  workspace.openworkWorkspaceName?.trim() ||
  workspace.name?.trim() ||
  workspace.directory?.trim() ||
  workspace.path?.trim() ||
  workspace.baseUrl?.trim() ||
  fallback;

export function SkillDestinationModal(props: SkillDestinationModalProps) {
  const translate = (key: string) => t(key, currentLocale());
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
    string | null
  >(null);

  const footerBusy = Boolean(props.busyWorkspaceId?.trim());
  const selectedWorkspace = useMemo(
    () =>
      props.workspaces.find(
        (workspace) => workspace.id === selectedWorkspaceId,
      ) ?? null,
    [props.workspaces, selectedWorkspaceId],
  );

  useEffect(() => {
    if (!props.open) return;
    const activeMatch =
      props.workspaces.find(
        (workspace) => workspace.id === props.selectedWorkspaceId,
      ) ??
      props.workspaces[0] ??
      null;
    setSelectedWorkspaceId(activeMatch?.id ?? null);
  }, [props.open, props.selectedWorkspaceId, props.workspaces]);

  const subtitle = (workspace: WorkspaceInfo): string => {
    if (workspace.workspaceType === "local") {
      return (
        workspace.path?.trim() ||
        translate("share_skill_destination.local_badge")
      );
    }
    return (
      workspace.directory?.trim() ||
      workspace.openworkHostUrl?.trim() ||
      workspace.baseUrl?.trim() ||
      workspace.path?.trim() ||
      translate("share_skill_destination.remote_badge")
    );
  };

  const workspaceBadge = (workspace: WorkspaceInfo): string => {
    if (isSandboxWorkspace(workspace)) {
      return translate("share_skill_destination.sandbox_badge");
    }
    if (workspace.workspaceType === "remote") {
      return translate("share_skill_destination.remote_badge");
    }
    return translate("share_skill_destination.local_badge");
  };

  const workspaceCircleClass = (
    workspace: WorkspaceInfo,
    selected: boolean,
  ): string => {
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

  const submitSelectedWorkspace = () => {
    const workspaceId = selectedWorkspaceId?.trim();
    if (!workspaceId || footerBusy) return;
    void props.onSubmitWorkspace(workspaceId);
  };

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-12/40 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-6 bg-gray-1 shadow-2xl">
        <div className="border-b border-gray-6 bg-gray-1 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-10">
                <Sparkles size={12} />
                {translate("share_skill_destination.skill_label")}
              </div>
              <div className="rounded-xl border border-gray-6 bg-gray-2/40 px-4 py-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-indigo-7/20 bg-indigo-7/10 text-indigo-11">
                    <Sparkles size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-9">
                      {translate("share_skill_destination.skill_label")}
                    </div>
                    <h3 className="mt-1 text-lg font-semibold text-gray-12 break-words">
                      {props.skill?.name ??
                        translate("share_skill_destination.fallback_skill_name")}
                    </h3>
                    {props.skill?.description?.trim() ? (
                      <p className="mt-1 text-sm leading-relaxed text-gray-10 break-words">
                        {props.skill.description.trim()}
                      </p>
                    ) : null}
                    {props.skill?.trigger?.trim() ? (
                      <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-1 px-3 py-1 text-[11px] text-gray-10">
                        <span className="font-semibold text-gray-12">
                          {translate("share_skill_destination.trigger_label")}
                        </span>
                        <span className="font-mono">
                          {props.skill.trigger.trim()}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-gray-12">
                  {translate("share_skill_destination.title")}
                </h4>
                <p className="mt-1 text-sm leading-relaxed text-gray-10">
                  {translate("share_skill_destination.subtitle")}
                </p>
              </div>
            </div>

            <button
              onClick={props.onClose}
              disabled={footerBusy}
              className={`rounded-full p-2 text-gray-9 transition hover:bg-gray-2 hover:text-gray-12 ${
                footerBusy ? "cursor-not-allowed opacity-50" : ""
              }`.trim()}
              aria-label={translate("common.close")}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-gray-12">
                {translate("share_skill_destination.existing_workers")}
              </div>
              {props.workspaces.length > 0 ? (
                <span className="text-[11px] uppercase tracking-[0.18em] text-gray-9">
                  {props.workspaces.length}
                </span>
              ) : null}
            </div>

            {props.workspaces.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-6 bg-gray-2/20 px-4 py-5 text-sm leading-relaxed text-gray-10">
                {translate("share_skill_destination.no_workers")}
              </div>
            ) : (
              <div className="space-y-2">
                {props.workspaces.map((workspace) => {
                  const isActive = workspace.id === props.selectedWorkspaceId;
                  const isSelected = workspace.id === selectedWorkspaceId;
                  const isBusy = workspace.id === props.busyWorkspaceId;

                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => setSelectedWorkspaceId(workspace.id)}
                      disabled={footerBusy}
                      aria-pressed={isSelected}
                      className={`w-full rounded-xl border text-left transition-colors ${
                        isSelected
                          ? "border-indigo-7/40 bg-indigo-2/20"
                          : "border-gray-6/40 bg-transparent hover:border-gray-7/50 hover:bg-gray-2"
                      } ${footerBusy ? "cursor-wait opacity-70" : ""}`.trim()}
                    >
                      <div className="flex items-start gap-3 px-4 py-3">
                        <div
                          className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${workspaceCircleClass(
                            workspace,
                            isSelected,
                          )}`.trim()}
                        >
                          {workspace.workspaceType === "remote" ? (
                            <Globe size={16} />
                          ) : (
                            <Folder size={16} />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-semibold text-gray-12 break-words">
                              {displayName(workspace, "Worker")}
                            </div>
                            {isActive ? (
                              <span className="rounded-full bg-gray-3 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-gray-11">
                                {translate("share_skill_destination.current_badge")}
                              </span>
                            ) : null}
                            <span className="rounded-full bg-gray-3 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-gray-11">
                              {workspaceBadge(workspace)}
                            </span>
                            {isSelected ? (
                              <span className="rounded-full bg-indigo-3/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-indigo-11">
                                {translate(
                                  "share_skill_destination.selected_badge",
                                )}
                              </span>
                            ) : null}
                          </div>

                          <div className="mt-1 text-[11px] font-mono break-all text-gray-8/80">
                            {subtitle(workspace)}
                          </div>
                          {isSelected ? (
                            <div className="mt-2 text-xs font-medium text-gray-11">
                              {translate(
                                "share_skill_destination.selected_hint",
                              )}
                            </div>
                          ) : null}
                        </div>

                        <div className="shrink-0 pt-0.5 text-gray-9">
                          {isBusy ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <CheckCircle2
                              size={16}
                              className={
                                isSelected ? "text-indigo-11" : "text-gray-7"
                              }
                            />
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {props.onCreateWorker || props.onConnectRemote ? (
            <div className="space-y-3 border-t border-gray-6 pt-5">
              <div className="text-sm font-medium text-gray-12">
                {translate("share_skill_destination.more_options")}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {props.onCreateWorker ? (
                  <button
                    type="button"
                    onClick={() => props.onCreateWorker?.()}
                    disabled={footerBusy}
                    className={`rounded-xl border border-indigo-7/30 bg-indigo-7/10 px-4 py-4 text-left transition hover:border-indigo-7/50 hover:bg-indigo-7/15 ${
                      footerBusy ? "cursor-not-allowed opacity-60" : ""
                    }`.trim()}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-full border border-indigo-7/30 bg-indigo-7/15 text-indigo-11">
                        <FolderPlus size={17} />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-gray-12">
                          {translate("share_skill_destination.create_worker")}
                        </div>
                        <div className="mt-1 text-sm text-gray-10">
                          {translate(
                            "share_skill_destination.create_worker_hint",
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                ) : null}

                {props.onConnectRemote ? (
                  <button
                    type="button"
                    onClick={() => props.onConnectRemote?.()}
                    disabled={footerBusy}
                    className={`rounded-xl border border-sky-7/30 bg-sky-7/10 px-4 py-4 text-left transition hover:border-sky-7/50 hover:bg-sky-7/15 ${
                      footerBusy ? "cursor-not-allowed opacity-60" : ""
                    }`.trim()}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-full border border-sky-7/30 bg-sky-7/15 text-sky-11">
                        <Globe size={17} />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-gray-12">
                          {translate("share_skill_destination.connect_remote")}
                        </div>
                        <div className="mt-1 text-sm text-gray-10">
                          {translate(
                            "share_skill_destination.connect_remote_hint",
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="border-t border-gray-6 bg-gray-1 px-6 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {selectedWorkspace ? (
              <div className="min-w-0 text-sm text-gray-10">
                <span className="font-medium text-gray-12">
                  {displayName(selectedWorkspace, "Worker")}
                </span>
                <span className="mx-2 text-gray-8">·</span>
                <span className="truncate align-middle">
                  {subtitle(selectedWorkspace)}
                </span>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-3">
              <Button
                variant="ghost"
                onClick={props.onClose}
                disabled={footerBusy}
              >
                {translate("common.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={submitSelectedWorkspace}
                disabled={!selectedWorkspace || footerBusy}
              >
                {footerBusy ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" />
                    {translate("share_skill_destination.adding")}
                  </span>
                ) : (
                  translate("share_skill_destination.add_to_workspace")
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
