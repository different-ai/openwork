import { For, Show } from "solid-js";

import { Boxes, FolderPlus, Loader2, XCircle } from "lucide-solid";

import type { DenTemplate } from "../lib/den";
import type { WorkspacePreset } from "../types";
import {
  errorBannerClass,
  iconTileClass,
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

export default function CreateWorkspaceLocalPanel(props: {
  translate: (key: string) => string;
  selectedFolder: string | null;
  hasSelectedFolder: boolean;
  pickingFolder: boolean;
  onPickFolder: () => void;
  submitting: boolean;
  selectedTemplateId: string | null;
  setSelectedTemplateId: (next: string | null | ((current: string | null) => string | null)) => void;
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
  extraWorkerLabel?: string;
  onConfirmExtraWorker?: (preset: WorkspacePreset, folder: string | null) => void;
  preset: WorkspacePreset;
  workerSubmitting: boolean;
  extraWorkerSubmitting: boolean;
  workerDisabled: boolean;
  workerDisabledReason: string | null;
  workerCtaLabel?: string;
  workerCtaDescription?: string;
  onWorkerCta?: () => void;
  workerRetryLabel?: string;
  onWorkerRetry?: () => void;
  workerDebugLines: string[];
  progress: {
    backend?: "docker" | "microsandbox";
    backendLabel?: string;
    runId: string;
    startedAt: number;
    stage: string;
    error: string | null;
    steps: Array<{
      key: string;
      label: string;
      status: "pending" | "active" | "done" | "error";
      detail?: string | null;
    }>;
    logs: string[];
  } | null;
  elapsedSeconds: number;
  showProgressDetails: boolean;
  onToggleProgressDetails: () => void;
}) {
  return (
    <>
      <div class={`${modalBodyClass} transition-opacity duration-300 ${props.submitting ? "pointer-events-none opacity-40" : "opacity-100"}`}>
        <div class="space-y-4">
          <div class={surfaceCardClass}>
            <div class={sectionTitleClass}>Workspace folder</div>
            <div class={sectionBodyClass}>Choose where this workspace should live on your device.</div>
            <div class="mt-4 rounded-[20px] border border-dls-border bg-dls-hover px-4 py-3">
              <Show when={props.hasSelectedFolder} fallback={<span class="text-[14px] text-dls-secondary">No folder selected yet.</span>}>
                <span class="block truncate font-mono text-[12px] text-dls-text">{props.selectedFolder}</span>
              </Show>
            </div>
            <div class="mt-4">
              <button
                type="button"
                onClick={props.onPickFolder}
                disabled={props.pickingFolder || props.submitting}
                class={pillSecondaryClass}
              >
                <Show when={props.pickingFolder} fallback={<FolderPlus size={14} />}>
                  <Loader2 size={14} class="animate-spin" />
                </Show>
                {props.hasSelectedFolder ? props.translate("dashboard.change") : "Select folder"}
              </button>
            </div>
          </div>

          <Show when={props.showTemplateSection}>
            <div class={surfaceCardClass}>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="flex items-center gap-2 text-[15px] font-medium tracking-[-0.2px] text-dls-text">
                    <Boxes size={16} class="text-dls-secondary" />
                    Team templates
                  </div>
                  <div class="mt-1 text-[13px] leading-relaxed text-dls-secondary">
                    Choose a starting point, or leave blank to create an empty workspace.
                  </div>
                </div>
                <Show when={props.templateCacheBusy}>
                  <div class={tagClass}>
                    <Loader2 size={12} class="animate-spin" />
                    Syncing
                  </div>
                </Show>
              </div>

              <Show when={props.templateError || props.templateCacheError}>
                {(value) => <div class={`mt-4 ${errorBannerClass}`}>{value()}</div>}
              </Show>

              <Show
                when={props.cloudWorkspaceTemplates.length > 0}
                fallback={
                  <div class={`mt-4 ${softCardClass} text-[14px] text-dls-secondary`}>
                    No shared workspace templates found for this org yet.
                  </div>
                }
              >
                <div class="mt-4 space-y-3">
                  <For each={props.cloudWorkspaceTemplates}>
                    {(template) => {
                      const selected = () => props.selectedTemplateId === template.id;
                      return (
                        <button
                          type="button"
                          class={`${surfaceCardClass} w-full transition-all duration-150 hover:border-dls-border hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)] ${selected() ? "border-[rgba(var(--dls-accent-rgb),0.2)] bg-[rgba(var(--dls-accent-rgb),0.06)] shadow-[inset_0_0_0_1px_rgba(var(--dls-accent-rgb),0.08)]" : ""}`.trim()}
                          onClick={() =>
                            props.setSelectedTemplateId((current) =>
                              current === template.id ? null : template.id,
                            )
                          }
                        >
                          <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0 text-left">
                              <div class="flex items-center gap-2">
                                <div class="truncate text-[14px] font-medium text-dls-text">{template.name}</div>
                                <Show when={selected()}>
                                  <span class={tagClass}>Selected</span>
                                </Show>
                              </div>
                              <div class="mt-1 text-[12px] text-dls-secondary">
                                {props.templateCreatorLabel(template)} · {props.formatTemplateTimestamp(template.updatedAt ?? template.createdAt)}
                              </div>
                            </div>
                            <div class={`mt-1 h-4 w-4 shrink-0 rounded-full border ${selected() ? "border-[var(--dls-accent)] bg-[var(--dls-accent)]" : "border-dls-border bg-dls-surface"}`.trim()} />
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <div class={modalFooterClass}>
        <Show when={props.submitting && props.progress}>
          {(progress) => (
            <div class={softCardClass}>
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 text-[12px] font-semibold text-dls-text">
                    <Show when={!progress().error} fallback={<XCircle size={14} class="text-red-11" />}>
                      <Loader2 size={14} class="animate-spin text-dls-accent" />
                    </Show>
                    {progress().backendLabel || "Sandbox"} setup
                  </div>
                  <div class="mt-1 truncate text-[14px] leading-snug text-dls-text">{progress().stage}</div>
                  <div class="mt-1 font-mono text-[10px] uppercase tracking-wider text-dls-secondary">{props.elapsedSeconds}s</div>
                </div>
                <button type="button" class={pillGhostClass} onClick={props.onToggleProgressDetails}>
                  {props.showProgressDetails ? "Hide logs" : "Show logs"}
                </button>
              </div>

              <Show when={progress().error}>
                {(err) => <div class={`mt-3 ${errorBannerClass}`}>{err()}</div>}
              </Show>

              <div class="mt-4 grid gap-2.5">
                <For each={progress().steps}>
                  {(step) => {
                    const icon = () => {
                      if (step.status === "done") return <XCircle size={16} class="text-emerald-10" />;
                      if (step.status === "active") return <Loader2 size={16} class="animate-spin text-dls-accent" />;
                      if (step.status === "error") return <XCircle size={16} class="text-red-10" />;
                      return <div class="h-4 w-4 rounded-full border-2 border-dls-border" />;
                    };

                    const textClass = () => {
                      if (step.status === "done") return "text-dls-text font-medium";
                      if (step.status === "active") return "text-dls-text font-semibold";
                      if (step.status === "error") return "text-red-11 font-medium";
                      return "text-dls-secondary";
                    };

                    return (
                      <div class="flex items-center gap-3">
                        <div class="flex h-5 w-5 shrink-0 items-center justify-center">{icon()}</div>
                        <div class="flex min-w-0 flex-1 items-center justify-between gap-2">
                          <div class={`text-[12px] ${textClass()} transition-colors duration-200`.trim()}>{step.label}</div>
                          <Show when={(step.detail ?? "").trim()}>
                            <div class={`${tagClass} max-w-[120px] truncate font-mono`}>{step.detail}</div>
                          </Show>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>

              <Show when={props.showProgressDetails && (progress().logs?.length ?? 0) > 0}>
                <div class={`mt-3 ${softCardClass}`}>
                  <div class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-dls-secondary">Live logs</div>
                  <div class="max-h-[120px] space-y-0.5 overflow-y-auto">
                    <For each={progress().logs.slice(-10)}>
                      {(line) => <div class="break-all font-mono text-[10px] leading-tight text-dls-text">{line}</div>}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          )}
        </Show>

        <Show when={props.onConfirmWorker && props.workerDisabled && props.workerDisabledReason}>
          <div class={warningBannerClass}>
            <div class="font-semibold text-amber-12">{props.translate("dashboard.sandbox_get_ready_title")}</div>
            <div class="mt-1 leading-relaxed">{props.workerDisabledReason || props.workerCtaDescription}</div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Show when={props.onWorkerCta && props.workerCtaLabel?.trim()}>
                <button type="button" class={pillSecondaryClass} onClick={props.onWorkerCta} disabled={props.submitting}>
                  {props.workerCtaLabel}
                </button>
              </Show>
              <Show when={props.onWorkerRetry && props.workerRetryLabel?.trim()}>
                <button type="button" class={pillGhostClass} onClick={props.onWorkerRetry} disabled={props.submitting}>
                  {props.workerRetryLabel}
                </button>
              </Show>
            </div>
            <Show when={props.workerDebugLines.length > 0}>
              <details class={`mt-3 ${softCardClass} text-[11px] text-dls-text`}>
                <summary class="cursor-pointer text-[12px] font-semibold text-dls-text">Docker debug details</summary>
                <div class="mt-2 space-y-1 break-words font-mono">
                  <For each={props.workerDebugLines}>{(line) => <div>{line}</div>}</For>
                </div>
              </details>
            </Show>
          </div>
        </Show>

        <div class="flex justify-end gap-3">
          <button type="button" onClick={props.onClose} disabled={props.submitting} class={pillGhostClass}>
            {props.translate("common.cancel")}
          </button>
          <Show when={props.onConfirmWorker}>
            <button
              type="button"
              onClick={() => props.onConfirmWorker?.(props.preset, props.selectedFolder)}
              disabled={!props.selectedFolder || props.submitting || props.workerSubmitting || props.workerDisabled}
              title={!props.selectedFolder ? props.translate("dashboard.choose_folder_continue") : props.workerDisabledReason || undefined}
              class={pillSecondaryClass}
            >
              <Show when={props.workerSubmitting} fallback={props.workerLabel ?? props.translate("dashboard.create_sandbox_confirm")}>
                <span class="inline-flex items-center gap-2">
                  <Loader2 size={16} class="animate-spin" />
                  {props.translate("dashboard.sandbox_checking_docker")}
                </span>
              </Show>
            </button>
          </Show>
          <Show when={props.onConfirmExtraWorker}>
            <button
              type="button"
              onClick={() => props.onConfirmExtraWorker?.(props.preset, props.selectedFolder)}
              disabled={!props.selectedFolder || props.submitting || props.extraWorkerSubmitting}
              title={!props.selectedFolder ? props.translate("dashboard.choose_folder_continue") : undefined}
              class={pillSecondaryClass}
            >
              <Show when={props.extraWorkerSubmitting} fallback={props.extraWorkerLabel ?? "Create MicroSandbox"}>
                <span class="inline-flex items-center gap-2">
                  <Loader2 size={16} class="animate-spin" />
                  Checking MicroSandbox…
                </span>
              </Show>
            </button>
          </Show>
          <button
            type="button"
            onClick={() => void props.onSubmit()}
            disabled={!props.selectedFolder || props.submitting}
            title={!props.selectedFolder ? props.translate("dashboard.choose_folder_continue") : undefined}
            class={pillPrimaryClass}
          >
            <Show when={props.submitting} fallback={props.confirmLabel ?? props.translate("dashboard.create_workspace_confirm")}>
              <span class="inline-flex items-center gap-2">
                <Loader2 size={16} class="animate-spin" />
                Creating…
              </span>
            </Show>
          </button>
        </div>
      </div>
    </>
  );
}
