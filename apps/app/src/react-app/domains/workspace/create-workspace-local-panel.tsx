/** @jsxImportSource react */
import { Boxes, FolderPlus, Loader2, XCircle } from "lucide-react";

import type { DenTemplate } from "../../../app/lib/den";
import type { WorkspacePreset } from "../../../app/types";
import {
  errorBannerClass,
  modalBodyClass,
  modalFooterClass,
  pillGhostClass,
  pillPrimaryClass,
  pillSecondaryClass,
  sectionBodyClass,
  sectionTitleClass,
  softCardClass,
  surfaceCardClass,
  tagClass,
  warningBannerClass,
} from "./modal-styles";

export type CreateWorkspaceProgressStep = {
  key: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string | null;
};

export type CreateWorkspaceProgressSnapshot = {
  runId: string;
  startedAt: number;
  stage: string;
  error: string | null;
  steps: CreateWorkspaceProgressStep[];
  logs: string[];
};

export type CreateWorkspaceLocalPanelProps = {
  translate: (key: string) => string;
  selectedFolder: string | null;
  hasSelectedFolder: boolean;
  pickingFolder: boolean;
  onPickFolder: () => void;
  submitting: boolean;
  selectedTemplateId: string | null;
  setSelectedTemplateId: (
    next: string | null | ((current: string | null) => string | null),
  ) => void;
  showTemplateSection: boolean;
  cloudWorkspaceTemplates: DenTemplate[];
  templateCreatorLabel: (template: DenTemplate) => string;
  formatTemplateTimestamp: (value: string | null) => string;
  templateError: string | null;
  templateCacheBusy: boolean;
  templateCacheError: string | null;
  onClose: () => void;
  onSubmit: () => void;
  confirmLabel?: string;
  workerLabel?: string;
  onConfirmWorker?: (preset: WorkspacePreset, folder: string | null) => void;
  preset: WorkspacePreset;
  workerSubmitting: boolean;
  workerDisabled: boolean;
  workerDisabledReason: string | null;
  workerCtaLabel?: string;
  workerCtaDescription?: string;
  onWorkerCta?: () => void;
  workerRetryLabel?: string;
  onWorkerRetry?: () => void;
  workerDebugLines: string[];
  progress: CreateWorkspaceProgressSnapshot | null;
  elapsedSeconds: number;
  showProgressDetails: boolean;
  onToggleProgressDetails: () => void;
};

function stepIcon(status: CreateWorkspaceProgressStep["status"]) {
  if (status === "done")
    return <XCircle size={16} className="text-emerald-10" />;
  if (status === "active")
    return <Loader2 size={16} className="animate-spin text-dls-accent" />;
  if (status === "error") return <XCircle size={16} className="text-red-10" />;
  return <div className="h-4 w-4 rounded-full border-2 border-dls-border" />;
}

function stepTextClass(status: CreateWorkspaceProgressStep["status"]) {
  if (status === "done") return "text-dls-text font-medium";
  if (status === "active") return "text-dls-text font-semibold";
  if (status === "error") return "text-red-11 font-medium";
  return "text-dls-secondary";
}

export function CreateWorkspaceLocalPanel(
  props: CreateWorkspaceLocalPanelProps,
) {
  const progress = props.progress;
  const templateBanner = props.templateError || props.templateCacheError;

  return (
    <>
      <div
        className={`${modalBodyClass} transition-opacity duration-300 ${props.submitting ? "pointer-events-none opacity-40" : "opacity-100"}`}
      >
        <div className="space-y-4">
          <div className={surfaceCardClass}>
            <div className={sectionTitleClass}>Workspace folder</div>
            <div className={sectionBodyClass}>
              Choose where this workspace should live on your device.
            </div>
            <div className="mt-4 rounded-[20px] border border-dls-border bg-dls-hover px-4 py-3">
              {props.hasSelectedFolder ? (
                <span className="block truncate font-mono text-[12px] text-dls-text">
                  {props.selectedFolder}
                </span>
              ) : (
                <span className="text-[14px] text-dls-secondary">
                  No folder selected yet.
                </span>
              )}
            </div>
            <div className="mt-4">
              <button
                type="button"
                onClick={props.onPickFolder}
                disabled={props.pickingFolder || props.submitting}
                className={pillSecondaryClass}
              >
                {props.pickingFolder ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <FolderPlus size={14} />
                )}
                {props.hasSelectedFolder
                  ? props.translate("dashboard.change")
                  : "Select folder"}
              </button>
            </div>
          </div>

          {props.showTemplateSection ? (
            <div className={surfaceCardClass}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.2px] text-dls-text">
                    <Boxes size={16} className="text-dls-secondary" />
                    Team templates
                  </div>
                  <div className="mt-1 text-[13px] leading-relaxed text-dls-secondary">
                    Choose a starting point, or leave blank to create an empty
                    workspace.
                  </div>
                </div>
                {props.templateCacheBusy ? (
                  <div className={tagClass}>
                    <Loader2 size={12} className="animate-spin" />
                    Syncing
                  </div>
                ) : null}
              </div>

              {templateBanner ? (
                <div className={`mt-4 ${errorBannerClass}`}>{templateBanner}</div>
              ) : null}

              {props.cloudWorkspaceTemplates.length === 0 ? (
                <div
                  className={`mt-4 ${softCardClass} text-[14px] text-dls-secondary`}
                >
                  No shared workspace templates found for this org yet.
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  {props.cloudWorkspaceTemplates.map((template) => {
                    const selected = props.selectedTemplateId === template.id;
                    return (
                      <button
                        key={template.id}
                        type="button"
                        className={`${surfaceCardClass} w-full transition-all duration-150 hover:border-dls-border hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)] ${
                          selected
                            ? "border-[rgba(var(--dls-accent-rgb),0.2)] bg-[rgba(var(--dls-accent-rgb),0.06)] shadow-[inset_0_0_0_1px_rgba(var(--dls-accent-rgb),0.08)]"
                            : ""
                        }`.trim()}
                        onClick={() =>
                          props.setSelectedTemplateId((current) =>
                            current === template.id ? null : template.id,
                          )
                        }
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 text-left">
                            <div className="flex items-center gap-2">
                              <div className="truncate text-[14px] font-medium text-dls-text">
                                {template.name}
                              </div>
                              {selected ? (
                                <span className={tagClass}>Selected</span>
                              ) : null}
                            </div>
                            <div className="mt-1 text-[12px] text-dls-secondary">
                              {props.templateCreatorLabel(template)} ·{" "}
                              {props.formatTemplateTimestamp(
                                template.updatedAt ?? template.createdAt,
                              )}
                            </div>
                          </div>
                          <div
                            className={`mt-1 h-4 w-4 shrink-0 rounded-full border ${
                              selected
                                ? "border-[var(--dls-accent)] bg-[var(--dls-accent)]"
                                : "border-dls-border bg-dls-surface"
                            }`.trim()}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className={modalFooterClass}>
        {props.submitting && progress ? (
          <div className={softCardClass}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-dls-text">
                  {progress.error ? (
                    <XCircle size={14} className="text-red-11" />
                  ) : (
                    <Loader2 size={14} className="animate-spin text-dls-accent" />
                  )}
                  Sandbox setup
                </div>
                <div className="mt-1 truncate text-[14px] leading-snug text-dls-text">
                  {progress.stage}
                </div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-dls-secondary">
                  {props.elapsedSeconds}s
                </div>
              </div>
              <button
                type="button"
                className={pillGhostClass}
                onClick={props.onToggleProgressDetails}
              >
                {props.showProgressDetails ? "Hide logs" : "Show logs"}
              </button>
            </div>

            {progress.error ? (
              <div className={`mt-3 ${errorBannerClass}`}>{progress.error}</div>
            ) : null}

            <div className="mt-4 grid gap-2.5">
              {progress.steps.map((step) => (
                <div key={step.key} className="flex items-center gap-3">
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                    {stepIcon(step.status)}
                  </div>
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <div
                      className={`text-[12px] ${stepTextClass(step.status)} transition-colors duration-200`.trim()}
                    >
                      {step.label}
                    </div>
                    {step.detail?.trim() ? (
                      <div
                        className={`${tagClass} max-w-[120px] truncate font-mono`}
                      >
                        {step.detail}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            {props.showProgressDetails && progress.logs.length > 0 ? (
              <div className={`mt-3 ${softCardClass}`}>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-dls-secondary">
                  Live logs
                </div>
                <div className="max-h-[120px] space-y-0.5 overflow-y-auto">
                  {progress.logs.slice(-10).map((line, index) => (
                    <div
                      key={`${progress.runId}-log-${index}`}
                      className="break-all font-mono text-[10px] leading-tight text-dls-text"
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {props.onConfirmWorker &&
        props.workerDisabled &&
        props.workerDisabledReason ? (
          <div className={warningBannerClass}>
            <div className="font-semibold text-amber-12">
              {props.translate("dashboard.sandbox_get_ready_title")}
            </div>
            <div className="mt-1 leading-relaxed">
              {props.workerDisabledReason || props.workerCtaDescription}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {props.onWorkerCta && props.workerCtaLabel?.trim() ? (
                <button
                  type="button"
                  className={pillSecondaryClass}
                  onClick={props.onWorkerCta}
                  disabled={props.submitting}
                >
                  {props.workerCtaLabel}
                </button>
              ) : null}
              {props.onWorkerRetry && props.workerRetryLabel?.trim() ? (
                <button
                  type="button"
                  className={pillGhostClass}
                  onClick={props.onWorkerRetry}
                  disabled={props.submitting}
                >
                  {props.workerRetryLabel}
                </button>
              ) : null}
            </div>
            {props.workerDebugLines.length > 0 ? (
              <details
                className={`mt-3 ${softCardClass} text-[11px] text-dls-text`}
              >
                <summary className="cursor-pointer text-[12px] font-semibold text-dls-text">
                  Docker debug details
                </summary>
                <div className="mt-2 space-y-1 break-words font-mono">
                  {props.workerDebugLines.map((line, index) => (
                    <div key={`docker-line-${index}`}>{line}</div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={props.onClose}
            disabled={props.submitting}
            className={pillGhostClass}
          >
            {props.translate("common.cancel")}
          </button>
          {props.onConfirmWorker ? (
            <button
              type="button"
              onClick={() =>
                props.onConfirmWorker?.(props.preset, props.selectedFolder)
              }
              disabled={
                !props.selectedFolder ||
                props.submitting ||
                props.workerSubmitting ||
                props.workerDisabled
              }
              title={
                !props.selectedFolder
                  ? props.translate("dashboard.choose_folder_continue")
                  : props.workerDisabledReason || undefined
              }
              className={pillSecondaryClass}
            >
              {props.workerSubmitting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  {props.translate("dashboard.sandbox_checking_docker")}
                </span>
              ) : (
                (props.workerLabel ??
                  props.translate("dashboard.create_sandbox_confirm"))
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void props.onSubmit()}
            disabled={!props.selectedFolder || props.submitting}
            title={
              !props.selectedFolder
                ? props.translate("dashboard.choose_folder_continue")
                : undefined
            }
            className={pillPrimaryClass}
          >
            {props.submitting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={16} className="animate-spin" />
                Creating…
              </span>
            ) : (
              (props.confirmLabel ??
                props.translate("dashboard.create_workspace_confirm"))
            )}
          </button>
        </div>
      </div>
    </>
  );
}
