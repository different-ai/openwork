import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { CheckCircle2, FolderPlus, Loader2, X, XCircle } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import Button from "./button";

export default function CreateWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (preset: "starter" | "automation" | "minimal", folder: string | null) => void;
  onConfirmWorker?: (preset: "starter" | "automation" | "minimal", folder: string | null) => void;
  onPickFolder: () => Promise<string | null>;
  submitting?: boolean;
  inline?: boolean;
  showClose?: boolean;
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

  const [preset, setPreset] = createSignal<"starter" | "automation" | "minimal">("starter");
  const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null);
  const [pickingFolder, setPickingFolder] = createSignal(false);

  createEffect(() => {
    if (props.open) {
      requestAnimationFrame(() => pickFolderRef?.focus());
    }
  });

  const options = () => [
    {
      id: "starter" as const,
      name: translate("dashboard.starter_workspace"),
      desc: translate("dashboard.starter_workspace_desc"),
    },
    {
      id: "minimal" as const,
      name: translate("dashboard.empty_workspace"),
      desc: translate("dashboard.empty_workspace_desc"),
    },
  ];

  const folderLabel = () => {
    const folder = selectedFolder();
    if (!folder) return translate("dashboard.choose_folder");
    const parts = folder.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? folder;
  };

  const folderSubLabel = () => {
    const folder = selectedFolder();
    if (!folder) return translate("dashboard.choose_folder_next");
    return folder;
  };

  const handlePickFolder = async () => {
    if (pickingFolder()) return;
    setPickingFolder(true);
    try {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const next = await props.onPickFolder();
      if (next) {
        setSelectedFolder(next);
      }
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
  const [showProgressDetails, setShowProgressDetails] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());

  createEffect(() => {
    if (!submitting()) {
      setShowProgressDetails(false);
      return;
    }

    const id = window.setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => window.clearInterval(id));
  });

  const elapsedSeconds = createMemo(() => {
    const p = progress();
    if (!p?.startedAt) return 0;
    return Math.max(0, Math.floor((now() - p.startedAt) / 1000));
  });

  const workerDisabled = () => Boolean(props.workerDisabled);
  const workerDisabledReason = () => (props.workerDisabledReason ?? "").trim();
  const showWorkerCallout = () => Boolean(props.onConfirmWorker && workerDisabled() && workerDisabledReason());
  const workerDebugLines = createMemo(() => (props.workerDebugLines ?? []).map((line) => line.trim()).filter(Boolean));

  const content = (
    <div class="bg-gray-2 border border-gray-6 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
      <div class="p-6 border-b border-gray-6 flex justify-between items-center bg-gray-1">
        <div>
          <h3 class="font-semibold text-gray-12 text-lg">{title()}</h3>
          <p class="text-gray-10 text-sm">{subtitle()}</p>
        </div>
        <Show when={showClose()}>
          <button
            onClick={props.onClose}
            disabled={submitting()}
            class={`hover:bg-gray-4 p-1 rounded-full ${submitting() ? "opacity-50 cursor-not-allowed" : ""}`.trim()}
          >
            <X size={20} class="text-gray-10" />
          </button>
        </Show>
      </div>

          <div class={`p-6 flex-1 overflow-y-auto space-y-8 transition-opacity duration-300 ${provisioning() ? "opacity-40 pointer-events-none" : "opacity-100"}`}>
            <div class="space-y-4">
              <div class="flex items-center gap-3 text-sm font-medium text-gray-12">
                <div class="w-6 h-6 rounded-full bg-gray-4 flex items-center justify-center text-xs">
                  1
                </div>
                {translate("dashboard.select_folder")}
              </div>
              <div class="ml-9">
                <button
                  type="button"
                  ref={pickFolderRef}
                  onClick={handlePickFolder}
                  disabled={pickingFolder() || submitting()}
                  class={`w-full border border-dashed border-gray-7 bg-gray-2/50 rounded-xl p-4 text-left transition ${
                    pickingFolder() ? "opacity-70 cursor-wait" : "hover:border-gray-7"
                  }`.trim()}
                >
                  <div class="flex items-center gap-3 text-gray-12">
                    <FolderPlus size={20} class="text-gray-11" />
                    <div class="flex-1 min-w-0">
                      <div class="text-sm font-medium text-gray-12 truncate">{folderLabel()}</div>
                      <div class="text-xs text-gray-10 font-mono truncate mt-1">{folderSubLabel()}</div>
                    </div>
                    <Show
                      when={pickingFolder()}
                      fallback={<span class="text-xs text-gray-10">{translate("dashboard.change")}</span>}
                    >
                      <span class="flex items-center gap-2 text-xs text-gray-10">
                        <Loader2 size={12} class="animate-spin" />
                        {translate("dashboard.opening")}
                      </span>
                    </Show>
                  </div>
                </button>
              </div>
            </div>

            <div class="space-y-4">
              <div class="flex items-center gap-3 text-sm font-medium text-gray-12">
                <div class="w-6 h-6 rounded-full bg-gray-4 flex items-center justify-center text-xs">
                  2
                </div>
                {translate("dashboard.choose_preset")}
              </div>
              <div class={`ml-9 grid gap-3 ${!selectedFolder() ? "opacity-50" : ""}`.trim()}>
                <For each={options()}>
                  {(opt) => (
                    <div
                      onClick={() => {
                        if (!selectedFolder()) return;
                        if (submitting()) return;
                        setPreset(opt.id);
                      }}
                      class={`p-4 rounded-xl border cursor-pointer transition-all ${
                        preset() === opt.id
                          ? "bg-indigo-7/10 border-indigo-7/50"
                          : "bg-gray-2 border-gray-6 hover:border-gray-7"
                      } ${!selectedFolder() || submitting() ? "pointer-events-none" : ""}`.trim()}
                    >
                      <div class="flex justify-between items-start">
                        <div>
                          <div
                            class={`font-medium text-sm ${
                              preset() === opt.id ? "text-indigo-11" : "text-gray-12"
                            }`}
                          >
                            {opt.name}
                          </div>
                          <div class="text-xs text-gray-10 mt-1">{opt.desc}</div>
                        </div>
                        <Show when={preset() === opt.id}>
                          <CheckCircle2 size={16} class="text-indigo-6" />
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>

      <div class="p-6 border-t border-gray-6 bg-gray-1 flex flex-col gap-3">
        <Show when={submitting() && progress()}>
          {(p) => (
            <div class="rounded-xl border border-gray-6 bg-gray-2/50 px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-xs font-semibold text-gray-12 flex items-center gap-2">
                    <Show when={!p().error} fallback={<XCircle size={14} class="text-red-11" />}>
                      <Loader2 size={14} class="text-indigo-11 animate-spin" />
                    </Show>
                    Sandbox setup
                  </div>
                  <div class="mt-1 text-sm text-gray-11 leading-snug truncate">{p().stage}</div>
                  <div class="mt-1 text-[10px] text-gray-9 font-mono uppercase tracking-wider">{elapsedSeconds()}s</div>
                </div>
                <button
                  type="button"
                  class="shrink-0 text-xs text-gray-10 hover:text-gray-12 transition-colors px-2 py-1 hover:bg-gray-4 rounded"
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
                      if (step.status === "done") return <CheckCircle2 size={16} class="text-emerald-10" />;
                      if (step.status === "active") return <Loader2 size={16} class="text-indigo-11 animate-spin" />;
                      if (step.status === "error") return <XCircle size={16} class="text-red-10" />;
                      return <div class="w-4 h-4 rounded-full border-2 border-gray-6" />;
                    };
                    
                    const textClass = () => {
                      if (step.status === "done") return "text-gray-11 font-medium";
                      if (step.status === "active") return "text-gray-12 font-semibold";
                      if (step.status === "error") return "text-red-11 font-medium";
                      return "text-gray-9";
                    };

                    return (
                      <div class="flex items-center gap-3">
                        <div class="shrink-0 flex items-center justify-center w-5 h-5">
                          {icon()}
                        </div>
                        <div class="min-w-0 flex-1 flex items-center justify-between gap-2">
                          <div class={`text-xs ${textClass()} transition-colors duration-200`.trim()}>{step.label}</div>
                          <Show when={(step.detail ?? "").trim()}>
                            <div class="text-[10px] text-gray-9 font-mono truncate max-w-[120px] bg-gray-3/50 px-1.5 py-0.5 rounded">
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
                  <div class="flex justify-between items-center mb-2">
                    <div class="text-[10px] uppercase tracking-wide font-semibold text-gray-10">Live Logs</div>
                  </div>
                  <div class="space-y-0.5 max-h-[120px] overflow-y-auto scrollbar-thin">
                    <For each={p().logs.slice(-10)}>
                      {(line) => (
                        <div class="text-[10px] text-gray-11 font-mono break-all leading-tight">{line}</div>
                      )}
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
              <div class="mt-1 text-amber-11 leading-relaxed">
                {workerDisabledReason() || props.workerCtaDescription?.trim()}
              </div>
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
                <div class="mt-2 space-y-1 font-mono break-words">
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
            <Button variant="ghost" onClick={props.onClose} disabled={submitting()}>
              {translate("common.cancel")}
            </Button>
          </Show>
          <Show when={props.onConfirmWorker}>
            <Button
              variant="outline"
              onClick={() => props.onConfirmWorker?.(preset(), selectedFolder())}
              disabled={!selectedFolder() || submitting() || workerSubmitting() || workerDisabled()}
              title={(() => {
                if (!selectedFolder()) return translate("dashboard.choose_folder_continue");
                if (workerDisabled() && workerDisabledReason()) return workerDisabledReason();
                return undefined;
              })()}
            >
              <Show when={workerSubmitting()} fallback={workerLabel()}>
                <span class="inline-flex items-center gap-2">
                  <Loader2 size={16} class="animate-spin" />
                  {translate("dashboard.sandbox_checking_docker")}
                </span>
              </Show>
            </Button>
          </Show>
          <Button
            onClick={() => props.onConfirm(preset(), selectedFolder())}
            disabled={!selectedFolder() || submitting()}
            title={!selectedFolder() ? translate("dashboard.choose_folder_continue") : undefined}
          >
            <Show when={submitting()} fallback={confirmLabel()}>
              <span class="inline-flex items-center gap-2">
                <Loader2 size={16} class="animate-spin" />
                Creating...
              </span>
            </Show>
          </Button>
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
            : "fixed inset-0 z-50 flex items-center justify-center bg-gray-1/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
        }
      >
        {content}
      </div>
    </Show>
  );
}
