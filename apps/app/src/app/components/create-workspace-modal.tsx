import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { FolderPlus, Loader2, X, XCircle } from "lucide-solid";
import { t, currentLocale } from "../../i18n";
import type { WorkspacePreset } from "../types";

import Button from "./button";

export default function CreateWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (preset: WorkspacePreset, folder: string | null) => void;
  onConfirmWorker?: (preset: WorkspacePreset, folder: string | null) => void;
  onPickFolder: () => Promise<string | null>;
  submitting?: boolean;
  inline?: boolean;
  showClose?: boolean;
  defaultPreset?: WorkspacePreset;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
  workerLabel?: string;
  workerDisabled?: boolean;
  workerDisabledReason?: string | null;
  workerCtaLabel?: string;
  workerCtaDescription?: string;
  onWorkerCta?: () => void;
  workerRetryLabel?: string;
  onWorkerRetry?: () => void;
  workerDebugLines?: string[];
  workerSubmitting?: boolean;
  submittingProgress?: {
    runId: string;
    startedAt: number;
    stage: string;
    error: string | null;
    steps: Array<{ key: string; label: string; status: "pending" | "active" | "done" | "error"; detail?: string | null }>;
    logs: string[];
  } | null;
}) {
  let pickFolderRef: HTMLButtonElement | undefined;
  const translate = (key: string) => t(key, currentLocale());

  const [preset, setPreset] = createSignal<WorkspacePreset>(props.defaultPreset ?? "starter");
  const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null);
  const [pickingFolder, setPickingFolder] = createSignal(false);
  const [showProgressDetails, setShowProgressDetails] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());

  createEffect(() => {
    if (props.open) {
      setPreset(props.defaultPreset ?? "starter");
      requestAnimationFrame(() => pickFolderRef?.focus());
    }
  });

  const handlePickFolder = async () => {
    if (pickingFolder()) return;
    setPickingFolder(true);
    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const next = await props.onPickFolder();
      if (next) setSelectedFolder(next);
    } finally {
      setPickingFolder(false);
    }
  };

  const showClose = () => props.showClose ?? true;
  const title = () => props.title ?? translate("dashboard.create_workspace_title");
  const subtitle = () => props.subtitle ?? translate("dashboard.create_workspace_subtitle");
  const confirmLabel = () => props.confirmLabel ?? translate("dashboard.create_workspace_confirm");
  const workerLabel = () => props.workerLabel ?? translate("dashboard.create_sandbox_confirm");
  const isInline = () => props.inline ?? false;
  const submitting = () => props.submitting ?? false;
  const workerSubmitting = () => props.workerSubmitting ?? false;
  const progress = createMemo(() => props.submittingProgress ?? null);
  const provisioning = createMemo(() => submitting() && Boolean(progress()));
  const workerDisabled = () => Boolean(props.workerDisabled);
  const workerDisabledReason = () => (props.workerDisabledReason ?? "").trim();
  const showWorkerCallout = () => Boolean(props.onConfirmWorker && workerDisabled() && workerDisabledReason());
  const workerDebugLines = createMemo(() => (props.workerDebugLines ?? []).map((line) => line.trim()).filter(Boolean));
  const hasSelectedFolder = createMemo(() => Boolean(selectedFolder()?.trim()));

  createEffect(() => {
    if (!submitting()) {
      setShowProgressDetails(false);
      return;
    }

    const id = window.setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => window.clearInterval(id));
  });

  const elapsedSeconds = createMemo(() => {
    const current = progress();
    if (!current?.startedAt) return 0;
    return Math.max(0, Math.floor((now() - current.startedAt) / 1000));
  });

  const content = (
    <div class="flex max-h-[90vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface">
      <div class="flex items-start justify-between gap-4 border-b border-dls-border bg-dls-surface px-6 py-5">
        <div class="min-w-0">
          <h3 class="text-[18px] font-semibold text-dls-text">{title()}</h3>
          <p class="mt-1 text-sm text-dls-secondary">{subtitle()}</p>
        </div>
        <Show when={showClose()}>
          <button
            onClick={props.onClose}
            disabled={submitting()}
            class={`flex h-8 w-8 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text ${submitting() ? "cursor-not-allowed opacity-50" : ""}`.trim()}
            aria-label="Close create workspace modal"
          >
            <X size={18} />
          </button>
        </Show>
      </div>

      <div class={`flex-1 overflow-y-auto px-6 py-6 transition-opacity duration-300 ${provisioning() ? "pointer-events-none opacity-40" : "opacity-100"}`}>
        <div class="rounded-xl border border-dls-border bg-dls-sidebar px-5 py-4">
          <div class="mb-1 flex items-center justify-between gap-3">
            <div class="text-[15px] font-semibold text-dls-text">Workspace folder</div>
          </div>
          <div class="mb-4 text-[13px] text-gray-11">
            <Show when={hasSelectedFolder()} fallback={translate("dashboard.choose_folder_next")}>
              <span class="font-mono text-xs">{selectedFolder()}</span>
            </Show>
          </div>
          <button
            type="button"
            ref={pickFolderRef}
            onClick={handlePickFolder}
            disabled={pickingFolder() || submitting()}
            class="flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface px-4 py-2 text-center text-xs font-medium text-dls-text transition-colors hover:border-gray-8 hover:bg-gray-2 disabled:cursor-wait disabled:opacity-70"
          >
            <Show when={pickingFolder()} fallback={<FolderPlus size={14} />}>
              <Loader2 size={14} class="animate-spin" />
            </Show>
            {hasSelectedFolder() ? translate("dashboard.change") : "Select folder"}
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-3 border-t border-dls-border bg-dls-surface px-6 py-5">
        <Show when={submitting() && progress()}>
          {(p) => (
            <div class="rounded-xl border border-gray-6 bg-gray-2/50 px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 text-xs font-semibold text-gray-12">
                    <Show when={!p().error} fallback={<XCircle size={14} class="text-red-11" />}>
                      <Loader2 size={14} class="animate-spin text-indigo-11" />
                    </Show>
                    Sandbox setup
                  </div>
                  <div class="mt-1 truncate text-sm leading-snug text-gray-11">{p().stage}</div>
                  <div class="mt-1 font-mono text-[10px] uppercase tracking-wider text-gray-9">{elapsedSeconds()}s</div>
                </div>
                <button
                  type="button"
                  class="shrink-0 rounded px-2 py-1 text-xs text-gray-10 transition-colors hover:bg-gray-4 hover:text-gray-12"
                  onClick={() => setShowProgressDetails((prev) => !prev)}
                >
                  {showProgressDetails() ? "Hide logs" : "Show logs"}
                </button>
              </div>

              <Show when={p().error}>
                {(err) => (
                  <div class="mt-3 rounded-lg border border-red-7/30 bg-red-2/40 px-3 py-2 text-xs text-red-11 animate-in fade-in">
                    {err()}
                  </div>
                )}
              </Show>

              <div class="mt-4 grid gap-2.5">
                <For each={p().steps}>
                  {(step) => {
                    const icon = () => {
                      if (step.status === "done") return <XCircle size={16} class="text-emerald-10" />;
                      if (step.status === "active") return <Loader2 size={16} class="animate-spin text-indigo-11" />;
                      if (step.status === "error") return <XCircle size={16} class="text-red-10" />;
                      return <div class="h-4 w-4 rounded-full border-2 border-gray-6" />;
                    };

                    const textClass = () => {
                      if (step.status === "done") return "text-gray-11 font-medium";
                      if (step.status === "active") return "text-gray-12 font-semibold";
                      if (step.status === "error") return "text-red-11 font-medium";
                      return "text-gray-9";
                    };

                    return (
                      <div class="flex items-center gap-3">
                        <div class="flex h-5 w-5 shrink-0 items-center justify-center">{icon()}</div>
                        <div class="flex min-w-0 flex-1 items-center justify-between gap-2">
                          <div class={`text-xs ${textClass()} transition-colors duration-200`.trim()}>{step.label}</div>
                          <Show when={(step.detail ?? "").trim()}>
                            <div class="max-w-[120px] truncate rounded bg-gray-3/50 px-1.5 py-0.5 font-mono text-[10px] text-gray-9">
                              {step.detail}
                            </div>
                          </Show>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>

              <Show when={showProgressDetails() && (p().logs?.length ?? 0) > 0}>
                <div class="mt-3 rounded-lg border border-gray-6 bg-black/5 px-3 py-2 animate-in fade-in">
                  <div class="mb-2 flex items-center justify-between">
                    <div class="text-[10px] font-semibold uppercase tracking-wide text-gray-10">Live Logs</div>
                  </div>
                  <div class="scrollbar-thin max-h-[120px] space-y-0.5 overflow-y-auto">
                    <For each={p().logs.slice(-10)}>
                      {(line) => <div class="break-all font-mono text-[10px] leading-tight text-gray-11">{line}</div>}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          )}
        </Show>

        <Show when={showWorkerCallout()}>
          <div class="rounded-xl border border-amber-7/30 bg-amber-2/40 px-4 py-3 text-xs text-amber-11">
            <div class="font-semibold text-amber-12">{translate("dashboard.sandbox_get_ready_title")}</div>
            <Show when={props.workerCtaDescription?.trim() || workerDisabledReason()}>
              <div class="mt-1 leading-relaxed text-amber-11">{workerDisabledReason() || props.workerCtaDescription?.trim()}</div>
            </Show>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Show when={props.onWorkerCta && props.workerCtaLabel?.trim()}>
                <Button variant="outline" onClick={props.onWorkerCta} disabled={submitting()}>
                  {props.workerCtaLabel}
                </Button>
              </Show>
              <Show when={props.onWorkerRetry && props.workerRetryLabel?.trim()}>
                <Button variant="ghost" onClick={props.onWorkerRetry} disabled={submitting()}>
                  {props.workerRetryLabel}
                </Button>
              </Show>
            </div>
            <Show when={workerDebugLines().length > 0}>
              <details class="mt-3 rounded-lg border border-gray-6 bg-gray-2/60 px-3 py-2 text-[11px] text-gray-11">
                <summary class="cursor-pointer text-xs font-semibold text-gray-12">Docker debug details</summary>
                <div class="mt-2 space-y-1 break-words font-mono">
                  <For each={workerDebugLines()}>
                    {(line) => <div>{line}</div>}
                  </For>
                </div>
              </details>
            </Show>
          </div>
        </Show>

        <div class="flex justify-end gap-3">
          <Show when={showClose()}>
            <button
              type="button"
              onClick={props.onClose}
              disabled={submitting()}
              class="rounded-full border border-dls-border bg-dls-surface px-4 py-2 text-center text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {translate("common.cancel")}
            </button>
          </Show>
          <Show when={props.onConfirmWorker}>
            <button
              type="button"
              onClick={() => props.onConfirmWorker?.(preset(), selectedFolder())}
              disabled={!selectedFolder() || submitting() || workerSubmitting() || workerDisabled()}
              title={(() => {
                if (!selectedFolder()) return translate("dashboard.choose_folder_continue");
                if (workerDisabled() && workerDisabledReason()) return workerDisabledReason();
                return undefined;
              })()}
              class="rounded-full border border-dls-border bg-dls-surface px-4 py-2 text-center text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Show when={workerSubmitting()} fallback={workerLabel()}>
                <span class="inline-flex items-center gap-2">
                  <Loader2 size={16} class="animate-spin" />
                  {translate("dashboard.sandbox_checking_docker")}
                </span>
              </Show>
            </button>
          </Show>
          <button
            type="button"
            onClick={() => props.onConfirm(preset(), selectedFolder())}
            disabled={!selectedFolder() || submitting()}
            title={!selectedFolder() ? translate("dashboard.choose_folder_continue") : undefined}
            class="rounded-full bg-dls-accent px-6 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--dls-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Show when={submitting()} fallback={confirmLabel()}>
              <span class="inline-flex items-center gap-2">
                <Loader2 size={16} class="animate-spin" />
                Creating...
              </span>
            </Show>
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Show when={props.open || isInline()}>
      <div
        class={
          isInline()
            ? "w-full"
            : "fixed inset-0 z-50 flex items-center justify-center bg-gray-1/60 p-4 animate-in fade-in duration-200"
        }
      >
        {content}
      </div>
    </Show>
  );
}
