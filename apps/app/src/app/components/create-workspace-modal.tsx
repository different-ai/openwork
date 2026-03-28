import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import {
  ArrowLeft,
  Boxes,
  ChevronRight,
  Cloud,
  FolderPlus,
  Globe,
  Loader2,
  RefreshCcw,
  Search,
  Server,
  X,
  XCircle,
} from "lucide-solid";

import { currentLocale, t } from "../../i18n";
import { usePlatform } from "../context/platform";
import {
  buildDenAuthUrl,
  createDenClient,
  type DenOrgSummary,
  type DenTemplate,
  type DenWorkerSummary,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
} from "../lib/den";
import { loadDenTemplateCache, readDenTemplateCacheSnapshot } from "../lib/den-template-cache";
import type { WorkspacePreset } from "../types";

import Button from "./button";

type Screen = "chooser" | "local" | "remote" | "shared";

type RemoteWorkspaceInput = {
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  openworkClientToken?: string | null;
  openworkHostToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
  closeModal?: boolean;
};

function statusBadgeClass(kind: "ready" | "warning" | "neutral" | "error") {
  switch (kind) {
    case "ready":
      return "border-emerald-500/25 bg-emerald-500/12 text-emerald-11";
    case "warning":
      return "border-amber-500/25 bg-amber-500/12 text-amber-11";
    case "error":
      return "border-rose-500/25 bg-rose-500/12 text-rose-11";
    default:
      return "border-dls-border bg-dls-sidebar text-dls-secondary";
  }
}

function workerStatusMeta(status: string) {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "healthy":
      return { label: "Ready", tone: "ready" as const, canOpen: true };
    case "provisioning":
    case "starting":
      return { label: "Starting", tone: "warning" as const, canOpen: false };
    case "failed":
    case "error":
      return { label: "Attention", tone: "error" as const, canOpen: false };
    case "stopped":
      return { label: "Stopped", tone: "neutral" as const, canOpen: false };
    default:
      return {
        label: normalized ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}` : "Unknown",
        tone: "neutral" as const,
        canOpen: normalized === "ready",
      };
  }
}

function formatTemplateTimestamp(value: string | null) {
  if (!value) return "Recently updated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently updated";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function templateCreatorLabel(template: DenTemplate) {
  const creator = template.creator;
  if (!creator) return "Unknown creator";
  return creator.name?.trim() || creator.email?.trim() || "Unknown creator";
}

function workerSecondaryLine(worker: DenWorkerSummary) {
  const parts = [worker.provider?.trim() || "Cloud worker"];
  if (worker.instanceUrl?.trim()) parts.push(worker.instanceUrl.trim());
  return parts.join(" · ");
}

export default function CreateWorkspaceModal(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: (preset: WorkspacePreset, folder: string | null) => void;
  onConfirmRemote?: (input: RemoteWorkspaceInput) => Promise<boolean> | boolean | void;
  onConfirmWorker?: (preset: WorkspacePreset, folder: string | null) => void;
  onPickFolder: () => Promise<string | null>;
  submitting?: boolean;
  remoteSubmitting?: boolean;
  remoteError?: string | null;
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
  onConfirmTemplate?: (template: DenTemplate, preset: WorkspacePreset, folder: string | null) => Promise<void> | void;
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
  let remoteUrlRef: HTMLInputElement | undefined;
  const translate = (key: string) => t(key, currentLocale());
  const platform = usePlatform();

  const [screen, setScreen] = createSignal<Screen>("chooser");
  const [preset, setPreset] = createSignal<WorkspacePreset>(props.defaultPreset ?? "starter");
  const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null);
  const [pickingFolder, setPickingFolder] = createSignal(false);
  const [showProgressDetails, setShowProgressDetails] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [cloudSettings, setCloudSettings] = createSignal(readDenSettings());
  const [selectedTemplateId, setSelectedTemplateId] = createSignal<string | null>(null);
  const [templateError, setTemplateError] = createSignal<string | null>(null);
  const [remoteUrl, setRemoteUrl] = createSignal("");
  const [remoteToken, setRemoteToken] = createSignal("");
  const [remoteDisplayName, setRemoteDisplayName] = createSignal("");
  const [remoteTokenVisible, setRemoteTokenVisible] = createSignal(false);
  const [orgs, setOrgs] = createSignal<DenOrgSummary[]>([]);
  const [activeOrgId, setActiveOrgId] = createSignal("");
  const [orgsBusy, setOrgsBusy] = createSignal(false);
  const [orgsError, setOrgsError] = createSignal<string | null>(null);
  const [workers, setWorkers] = createSignal<DenWorkerSummary[]>([]);
  const [workersBusy, setWorkersBusy] = createSignal(false);
  const [workersError, setWorkersError] = createSignal<string | null>(null);
  const [openingWorkerId, setOpeningWorkerId] = createSignal<string | null>(null);
  const [workerSearch, setWorkerSearch] = createSignal("");

  const showClose = () => props.showClose ?? true;
  const isInline = () => props.inline ?? false;
  const submitting = () => props.submitting ?? false;
  const remoteSubmitting = () => props.remoteSubmitting ?? false;
  const workerSubmitting = () => props.workerSubmitting ?? false;
  const progress = createMemo(() => props.submittingProgress ?? null);
  const provisioning = createMemo(() => submitting() && Boolean(progress()));
  const workerDisabled = () => Boolean(props.workerDisabled);
  const workerDisabledReason = () => (props.workerDisabledReason ?? "").trim();
  const workerDebugLines = createMemo(() => (props.workerDebugLines ?? []).map((line) => line.trim()).filter(Boolean));
  const hasSelectedFolder = createMemo(() => Boolean(selectedFolder()?.trim()));
  const remoteError = createMemo(() => (props.remoteError ?? "").trim() || null);
  const isSignedIn = createMemo(() => Boolean(cloudSettings().authToken?.trim()));
  const activeOrg = createMemo(() => orgs().find((org) => org.id === activeOrgId()) ?? null);
  const denClient = createMemo(() => createDenClient({ baseUrl: cloudSettings().baseUrl, token: cloudSettings().authToken ?? "" }));

  const templateCacheSnapshot = createMemo(() =>
    readDenTemplateCacheSnapshot({
      baseUrl: cloudSettings().baseUrl,
      token: cloudSettings().authToken,
      orgSlug: cloudSettings().activeOrgSlug,
    }),
  );
  const cloudWorkspaceTemplates = createMemo(() =>
    templateCacheSnapshot().templates.filter((template) => {
      const payload = template.templateData;
      return Boolean(payload && typeof payload === "object" && (payload as { type?: unknown }).type === "workspace-profile");
    }),
  );
  const showTemplateSection = createMemo(
    () => Boolean(props.onConfirmTemplate && cloudSettings().authToken?.trim() && cloudSettings().activeOrgSlug?.trim()),
  );
  const selectedTemplate = createMemo(
    () => cloudWorkspaceTemplates().find((template) => template.id === selectedTemplateId()) ?? null,
  );
  const elapsedSeconds = createMemo(() => {
    const current = progress();
    if (!current?.startedAt) return 0;
    return Math.max(0, Math.floor((now() - current.startedAt) / 1000));
  });
  const filteredWorkers = createMemo(() => {
    const query = workerSearch().trim().toLowerCase();
    if (!query) return workers();
    return workers().filter((worker) => {
      const haystack = [worker.workerName, worker.provider, worker.instanceUrl, worker.status]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  });

  const modalWidthClass = createMemo(() => (screen() === "shared" ? "max-w-[600px]" : "max-w-[500px]"));
  const headerTitle = createMemo(() => {
    switch (screen()) {
      case "local":
        return "Local workspace";
      case "remote":
        return "Connect custom remote";
      case "shared":
        return "Shared workspaces";
      default:
        return props.title ?? translate("dashboard.create_workspace_title");
    }
  });
  const headerSubtitle = createMemo(() => {
    switch (screen()) {
      case "local":
        return "Create a workspace on this device, optionally starting from a team template.";
      case "remote":
        return "Attach to a self-hosted OpenWork worker.";
      case "shared":
        return isSignedIn()
          ? "Browse cloud workers shared with your organization and connect in one step."
          : "Sign in to OpenWork Cloud to access workers shared with your organization.";
      default:
        return props.subtitle ?? translate("dashboard.create_workspace_subtitle");
    }
  });

  createEffect(() => {
    if (props.open) {
      const settings = readDenSettings();
      setScreen("chooser");
      setPreset(props.defaultPreset ?? "starter");
      setCloudSettings(settings);
      setSelectedTemplateId(null);
      setTemplateError(null);
      setRemoteUrl("");
      setRemoteToken("");
      setRemoteDisplayName("");
      setRemoteTokenVisible(false);
      setWorkerSearch("");
      setOrgs([]);
      setWorkers([]);
      setOrgsError(null);
      setWorkersError(null);
      setActiveOrgId(settings.activeOrgId?.trim() ?? "");
      requestAnimationFrame(() => pickFolderRef?.focus());
    }
  });

  createEffect(() => {
    if (!props.open && !isInline()) return;
    const handler = () => {
      const settings = readDenSettings();
      setCloudSettings(settings);
      setActiveOrgId(settings.activeOrgId?.trim() ?? "");
    };
    window.addEventListener("openwork-den-session-updated", handler as EventListener);
    onCleanup(() => window.removeEventListener("openwork-den-session-updated", handler as EventListener));
  });

  createEffect(() => {
    if (!showTemplateSection() || (!props.open && !isInline())) return;
    void loadDenTemplateCache(
      {
        baseUrl: cloudSettings().baseUrl,
        token: cloudSettings().authToken,
        orgSlug: cloudSettings().activeOrgSlug,
      },
      { force: true },
    ).catch(() => undefined);
  });

  createEffect(() => {
    if (!submitting()) {
      setShowProgressDetails(false);
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => window.clearInterval(id));
  });

  createEffect(() => {
    if (!props.open) return;
    if (screen() === "local") {
      requestAnimationFrame(() => pickFolderRef?.focus());
    }
    if (screen() === "remote") {
      requestAnimationFrame(() => remoteUrlRef?.focus());
    }
  });

  createEffect(() => {
    if (!props.open || screen() !== "shared" || !isSignedIn()) return;
    void refreshOrgs();
  });

  createEffect(() => {
    if (!props.open || screen() !== "shared" || !isSignedIn()) return;
    const orgId = activeOrgId().trim();
    if (!orgId) return;
    void refreshWorkers(orgId);
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

  const applyActiveOrg = (nextOrg: DenOrgSummary | null) => {
    setActiveOrgId(nextOrg?.id ?? "");
    const nextSettings = {
      ...cloudSettings(),
      activeOrgId: nextOrg?.id ?? null,
      activeOrgSlug: nextOrg?.slug ?? null,
      activeOrgName: nextOrg?.name ?? null,
    };
    writeDenSettings(nextSettings);
    setCloudSettings(nextSettings);
  };

  const refreshOrgs = async () => {
    if (!isSignedIn()) return;
    setOrgsBusy(true);
    setOrgsError(null);
    try {
      const { orgs: nextOrgs, defaultOrgId } = await denClient().listOrgs();
      setOrgs(nextOrgs);
      const preferred = cloudSettings().activeOrgId?.trim();
      const nextActive =
        nextOrgs.find((org) => org.id === preferred) ??
        nextOrgs.find((org) => org.id === defaultOrgId) ??
        nextOrgs[0] ??
        null;
      applyActiveOrg(nextActive);
    } catch (error) {
      setOrgsError(error instanceof Error ? error.message : "Failed to load organizations.");
    } finally {
      setOrgsBusy(false);
    }
  };

  const refreshWorkers = async (orgId = activeOrgId().trim()) => {
    if (!orgId || !isSignedIn()) return;
    setWorkersBusy(true);
    setWorkersError(null);
    try {
      const nextWorkers = await denClient().listWorkers(orgId);
      setWorkers(nextWorkers);
    } catch (error) {
      setWorkersError(error instanceof Error ? error.message : "Failed to load shared workspaces.");
    } finally {
      setWorkersBusy(false);
    }
  };

  const openCloudSignIn = () => {
    platform.openLink(buildDenAuthUrl(cloudSettings().baseUrl, "sign-in"));
  };

  const openCloudDashboard = () => {
    platform.openLink(resolveDenBaseUrls(cloudSettings().baseUrl).baseUrl);
  };

  const handleRemoteSubmit = async () => {
    if (!props.onConfirmRemote) return;
    await Promise.resolve(
      props.onConfirmRemote({
        openworkHostUrl: remoteUrl().trim(),
        openworkToken: remoteToken().trim() || null,
        directory: null,
        displayName: remoteDisplayName().trim() || null,
        closeModal: true,
      }),
    );
  };

  const handleOpenWorker = async (worker: DenWorkerSummary) => {
    if (!props.onConfirmRemote) return;
    const orgId = activeOrgId().trim();
    if (!orgId) {
      setWorkersError("Choose an organization before opening a workspace.");
      return;
    }
    setOpeningWorkerId(worker.workerId);
    setWorkersError(null);
    try {
      const tokens = await denClient().getWorkerTokens(worker.workerId, orgId);
      const openworkUrl = tokens.openworkUrl?.trim() ?? "";
      const accessToken = tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
      if (!openworkUrl || !accessToken) {
        throw new Error("Workspace is not ready to connect yet. Try again in a moment.");
      }
      const ok = await Promise.resolve(
        props.onConfirmRemote({
          openworkHostUrl: openworkUrl,
          openworkToken: accessToken,
          openworkClientToken: tokens.clientToken?.trim() || null,
          openworkHostToken: tokens.hostToken?.trim() || null,
          directory: null,
          displayName: worker.workerName,
          closeModal: true,
        }),
      );
      if (ok === false) {
        throw new Error(`Failed to connect to ${worker.workerName}.`);
      }
    } catch (error) {
      setWorkersError(error instanceof Error ? error.message : `Failed to connect to ${worker.workerName}.`);
    } finally {
      setOpeningWorkerId(null);
    }
  };

  const handleLocalSubmit = async () => {
    const template = selectedTemplate();
    if (template && props.onConfirmTemplate) {
      try {
        setTemplateError(null);
        await props.onConfirmTemplate(template, preset(), selectedFolder());
      } catch (error) {
        setTemplateError(error instanceof Error ? error.message : `Failed to create ${template.name}.`);
      }
      return;
    }
    props.onConfirm(preset(), selectedFolder());
  };

  const headerButtonClass =
    "inline-flex h-9 w-9 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50";
  const chooserCardClass =
    "group flex w-full items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface px-5 py-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-dls-accent hover:bg-dls-hover hover:shadow-[var(--dls-card-shadow)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.16)]";
  const cardButtonClass =
    "w-full rounded-2xl border border-dls-border bg-dls-surface p-5 text-left transition-all duration-150 hover:border-dls-accent hover:bg-dls-hover hover:shadow-[var(--dls-card-shadow)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.16)]";
  const fieldLabelClass = "text-[13px] font-medium text-dls-text";
  const fieldHintClass = "text-[12px] leading-5 text-dls-secondary";
  const inputClass =
    "ow-input rounded-xl px-4 py-3 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none";

  const chooserBody = (
    <div class="space-y-3 px-6 py-6">
      <button type="button" class={chooserCardClass} onClick={() => setScreen("local")}>
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-sidebar text-dls-text">
          <FolderPlus size={18} />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-[15px] font-semibold text-dls-text">Local workspace</div>
          <div class="mt-1 text-[13px] text-dls-secondary">Create a workspace on this device and optionally start from a team template.</div>
        </div>
        <ChevronRight size={18} class="shrink-0 text-dls-secondary transition-transform group-hover:translate-x-0.5" />
      </button>

      <button type="button" class={chooserCardClass} onClick={() => setScreen("remote")}>
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-sidebar text-dls-text">
          <Globe size={18} />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-[15px] font-semibold text-dls-text">Connect custom remote</div>
          <div class="mt-1 text-[13px] text-dls-secondary">Attach to a self-hosted OpenWork worker using a URL and access token.</div>
        </div>
        <ChevronRight size={18} class="shrink-0 text-dls-secondary transition-transform group-hover:translate-x-0.5" />
      </button>

      <button type="button" class={chooserCardClass} onClick={() => setScreen("shared")}>
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-sidebar text-dls-text">
          <Cloud size={18} />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-[15px] font-semibold text-dls-text">Shared workspaces</div>
          <div class="mt-1 text-[13px] text-dls-secondary">Browse cloud workers shared with your organization and connect in one step.</div>
        </div>
        <ChevronRight size={18} class="shrink-0 text-dls-secondary transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  );

  const localBody = (
    <div class={`flex-1 overflow-y-auto px-6 py-6 transition-opacity duration-300 ${provisioning() ? "pointer-events-none opacity-40" : "opacity-100"}`}>
      <div class="space-y-4">
        <div class="ow-soft-card p-5">
          <div class="text-[15px] font-semibold text-dls-text">Workspace folder</div>
          <div class="mt-1 text-[13px] text-dls-secondary">Choose where this workspace should live on your device.</div>
          <div class="mt-4 rounded-2xl border border-dls-border bg-dls-sidebar px-4 py-3">
            <Show when={hasSelectedFolder()} fallback={<span class="text-sm text-dls-secondary">No folder selected yet.</span>}>
              <span class="block truncate font-mono text-xs text-dls-text">{selectedFolder()}</span>
            </Show>
          </div>
          <div class="mt-4">
            <button
              type="button"
              ref={pickFolderRef}
              onClick={handlePickFolder}
              disabled={pickingFolder() || submitting()}
              class="ow-button-secondary flex items-center gap-2 px-4 py-2 text-xs disabled:cursor-wait disabled:opacity-70"
            >
              <Show when={pickingFolder()} fallback={<FolderPlus size={14} />}>
                <Loader2 size={14} class="animate-spin" />
              </Show>
              {hasSelectedFolder() ? translate("dashboard.change") : "Select folder"}
            </button>
          </div>
        </div>

        <Show when={showTemplateSection()}>
          <div class="ow-soft-card p-5">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="flex items-center gap-2 text-[15px] font-semibold text-dls-text">
                  <Boxes size={16} class="text-dls-secondary" />
                  Team templates
                </div>
                <div class="mt-1 text-[13px] text-dls-secondary">
                  Choose a starting point, or leave blank to create an empty workspace.
                </div>
              </div>
              <Show when={templateCacheSnapshot().busy}>
                <div class="inline-flex items-center gap-2 rounded-full border border-dls-border bg-dls-surface px-3 py-1 text-[11px] font-medium text-dls-secondary">
                  <Loader2 size={12} class="animate-spin" />
                  Syncing
                </div>
              </Show>
            </div>

            <Show when={templateError() || templateCacheSnapshot().error}>
              {(value) => (
                <div class="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {value()}
                </div>
              )}
            </Show>

            <Show
              when={cloudWorkspaceTemplates().length > 0}
              fallback={
                  <div class="mt-4 rounded-2xl border border-dashed border-dls-border bg-dls-sidebar px-4 py-4 text-sm text-dls-secondary">
                  No shared workspace templates found for this org yet.
                </div>
              }
            >
              <div class="mt-4 space-y-3">
                <For each={cloudWorkspaceTemplates()}>
                  {(template) => {
                    const selected = () => selectedTemplateId() === template.id;
                    return (
                      <button
                        type="button"
                        class={`${cardButtonClass} ${selected() ? "border-[rgba(var(--dls-accent-rgb),0.2)] bg-[rgba(var(--dls-accent-rgb),0.06)] shadow-[inset_0_0_0_1px_rgba(var(--dls-accent-rgb),0.08)]" : ""}`.trim()}
                        onClick={() => {
                          setTemplateError(null);
                          setSelectedTemplateId((current) => (current === template.id ? null : template.id));
                        }}
                      >
                        <div class="flex items-start justify-between gap-3">
                          <div class="min-w-0">
                            <div class="flex items-center gap-2">
                              <div class="truncate text-sm font-medium text-dls-text">{template.name}</div>
                              <Show when={selected()}>
                                <span class="rounded-full bg-[rgba(var(--dls-accent-rgb),0.1)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-dls-text">
                                  Selected
                                </span>
                              </Show>
                            </div>
                            <div class="mt-1 text-[11px] text-dls-secondary">
                              {templateCreatorLabel(template)} · {formatTemplateTimestamp(template.updatedAt ?? template.createdAt)}
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
  );

  const remoteBody = (
    <div class="flex-1 overflow-y-auto px-6 py-6">
      <div class="space-y-4">
        <div class="ow-soft-card p-5">
          <div class="flex items-start gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-sidebar text-dls-text">
              <Server size={17} />
            </div>
            <div class="min-w-0">
              <div class="text-[15px] font-semibold text-dls-text">Remote server details</div>
              <div class="mt-1 text-[13px] text-dls-secondary">Attach to a self-hosted OpenWork worker.</div>
            </div>
          </div>

          <div class="mt-5 grid gap-4">
            <label class="grid gap-2">
              <span class={fieldLabelClass}>Worker URL</span>
              <input
                ref={remoteUrlRef}
                type="url"
                value={remoteUrl()}
                onInput={(event) => setRemoteUrl(event.currentTarget.value)}
                placeholder={translate("dashboard.openwork_host_placeholder")}
                disabled={remoteSubmitting()}
                class={inputClass}
              />
              <span class={fieldHintClass}>Paste the URL for the OpenWork worker you want to connect to.</span>
            </label>

            <label class="grid gap-2">
              <span class={fieldLabelClass}>Access token</span>
              <div class="ow-input flex items-center gap-2 rounded-xl p-1.5">
                <input
                  type={remoteTokenVisible() ? "text" : "password"}
                  value={remoteToken()}
                  onInput={(event) => setRemoteToken(event.currentTarget.value)}
                  placeholder={translate("dashboard.openwork_host_token_placeholder")}
                  disabled={remoteSubmitting()}
                  class="min-w-0 flex-1 border-none bg-transparent px-2 py-1.5 text-sm text-dls-text outline-none placeholder:text-dls-secondary"
                />
                <button
                  type="button"
                  class="ow-button-secondary px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => setRemoteTokenVisible((prev) => !prev)}
                  disabled={remoteSubmitting()}
                >
                  {remoteTokenVisible() ? translate("common.hide") : translate("common.show")}
                </button>
              </div>
              <span class={fieldHintClass}>Add a token only if the worker requires one.</span>
            </label>

            <label class="grid gap-2">
              <span class={fieldLabelClass}>Display name <span class="font-normal text-dls-secondary">(optional)</span></span>
              <input
                type="text"
                value={remoteDisplayName()}
                onInput={(event) => setRemoteDisplayName(event.currentTarget.value)}
                placeholder={translate("dashboard.remote_display_name_placeholder")}
                disabled={remoteSubmitting()}
                class={inputClass}
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );

  const sharedSignedOutBody = (
    <div class="flex-1 overflow-y-auto px-6 py-6">
      <div class="flex min-h-[320px] items-center justify-center">
        <div class="ow-soft-card w-full max-w-[420px] p-8 text-center">
          <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-sidebar text-dls-text">
            <Cloud size={24} />
          </div>
          <div class="mt-5 text-[20px] font-semibold text-dls-text">Sign in to OpenWork Cloud</div>
          <div class="mt-2 text-sm leading-6 text-dls-secondary">
            Access remote workers shared with your organization.
          </div>
          <div class="mt-6 flex justify-center">
            <button type="button" class="ow-button-primary px-6 py-2.5 text-sm" onClick={openCloudSignIn}>
              Continue with Cloud
            </button>
          </div>
          <div class="mt-3 text-xs text-dls-secondary">
            You’ll pick a team and connect to an existing workspace next.
          </div>
        </div>
      </div>
    </div>
  );

  const sharedSignedInBody = (
    <div class="flex-1 overflow-y-auto px-6 py-6">
      <div class="space-y-4">
        <div class="ow-soft-card p-5">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex min-w-0 items-center gap-2">
              <select
                value={activeOrgId()}
                onChange={(event) => {
                  const nextId = event.currentTarget.value;
                  const nextOrg = orgs().find((org) => org.id === nextId) ?? null;
                  applyActiveOrg(nextOrg);
                }}
                disabled={orgsBusy() || orgs().length === 0}
                class="ow-input h-10 rounded-xl px-4 py-2 text-sm font-medium text-dls-text"
              >
                <For each={orgs()}>
                  {(org) => <option value={org.id}>{org.name}</option>}
                </For>
              </select>
              <button
                type="button"
                class="ow-button-secondary h-10 px-4 py-2 text-xs"
                onClick={() => void refreshWorkers()}
                disabled={workersBusy() || !activeOrgId().trim()}
              >
                <RefreshCcw size={13} class={workersBusy() ? "animate-spin" : ""} />
              </button>
            </div>
          </div>

          <div class="mt-4">
            <label class="flex items-center gap-3 rounded-2xl border border-dls-border bg-dls-surface px-4 py-3">
              <Search size={15} class="shrink-0 text-dls-secondary" />
              <input
                type="text"
                value={workerSearch()}
                onInput={(event) => setWorkerSearch(event.currentTarget.value)}
                placeholder="Search shared workspaces"
                class="min-w-0 flex-1 border-none bg-transparent text-sm text-dls-text outline-none placeholder:text-dls-secondary"
              />
            </label>
          </div>
        </div>

        <Show when={orgsError()}>
          {(value) => <div class="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-11">{value()}</div>}
        </Show>
        <Show when={workersError()}>
          {(value) => <div class="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-11">{value()}</div>}
        </Show>

        <Show when={workersBusy() && workers().length === 0}>
          <div class="ow-soft-card p-5 text-sm text-dls-secondary">Loading shared workspaces…</div>
        </Show>

        <Show when={!workersBusy() && filteredWorkers().length === 0}>
          <div class="ow-soft-card p-5 text-sm text-dls-secondary">
            {workerSearch().trim() ? "No shared workspaces match that search." : "No shared workspaces available yet."}
          </div>
        </Show>

        <div class="space-y-3">
          <For each={filteredWorkers()}>
            {(worker) => {
              const status = createMemo(() => workerStatusMeta(worker.status));
              return (
                <div class="rounded-2xl border border-dls-border bg-dls-surface p-5 transition-all duration-150 hover:border-dls-accent hover:shadow-[var(--dls-card-shadow)]">
                  <div class="flex items-center gap-4">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-sidebar text-dls-secondary">
                      <Boxes size={18} />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <div class="truncate text-[14px] font-medium text-dls-text">{worker.workerName}</div>
                        <span class={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${statusBadgeClass(status().tone)}`.trim()}>
                          <span class="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
                          {status().label}
                        </span>
                      </div>
                      <div class="mt-1 truncate text-[12px] text-dls-secondary">{workerSecondaryLine(worker)}</div>
                    </div>
                    <button
                      type="button"
                      class="inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-dls-border bg-dls-surface px-3.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={openingWorkerId() !== null || !status().canOpen || !props.onConfirmRemote}
                      title={!props.onConfirmRemote ? "Connecting shared workspaces is unavailable here." : !status().canOpen ? "This workspace is not ready to connect yet." : undefined}
                      onClick={() => void handleOpenWorker(worker)}
                    >
                      <Show when={openingWorkerId() === worker.workerId} fallback="Connect">
                        <span class="inline-flex items-center gap-2">
                          <Loader2 size={13} class="animate-spin" />
                          Connecting
                        </span>
                      </Show>
                    </button>
                  </div>
                </div>
              );
            }}
          </For>
        </div>

        <Show when={workersBusy() && workers().length > 0}>
          <div class="text-xs text-dls-secondary">Refreshing workspaces…</div>
        </Show>

        <div class="pt-2">
          <button type="button" class="ow-button-secondary px-4 py-2 text-xs" onClick={openCloudDashboard}>
            Open cloud dashboard
          </button>
        </div>
      </div>
    </div>
  );

  const localFooter = (
    <div class="space-y-3 px-6 py-5">
      <Show when={submitting() && progress()}>
        {(p) => (
          <div class="ow-soft-card-quiet animate-in fade-in slide-in-from-bottom-2 rounded-xl px-4 py-3 duration-300">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2 text-xs font-semibold text-dls-text">
                  <Show when={!p().error} fallback={<XCircle size={14} class="text-red-11" />}>
                    <Loader2 size={14} class="animate-spin text-indigo-11" />
                  </Show>
                  Sandbox setup
                </div>
                <div class="mt-1 truncate text-sm leading-snug text-dls-text">{p().stage}</div>
                <div class="mt-1 font-mono text-[10px] uppercase tracking-wider text-dls-secondary">{elapsedSeconds()}s</div>
              </div>
              <button
                type="button"
                class="shrink-0 rounded-full px-3 py-1.5 text-xs text-dls-secondary transition-colors hover:bg-dls-surface hover:text-dls-text"
                onClick={() => setShowProgressDetails((prev) => !prev)}
              >
                {showProgressDetails() ? "Hide logs" : "Show logs"}
              </button>
            </div>

            <Show when={p().error}>
              {(err) => (
                <div class="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-11 animate-in fade-in">
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
                        <div class={`text-xs ${textClass()} transition-colors duration-200`.trim()}>{step.label}</div>
                        <Show when={(step.detail ?? "").trim()}>
                          <div class="max-w-[120px] truncate rounded-full border border-dls-border bg-dls-surface px-2 py-0.5 font-mono text-[10px] text-dls-secondary">
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
              <div class="mt-3 rounded-lg border border-dls-border bg-dls-sidebar px-3 py-2 animate-in fade-in">
                <div class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-dls-secondary">Live Logs</div>
                <div class="max-h-[120px] space-y-0.5 overflow-y-auto">
                  <For each={p().logs.slice(-10)}>
                    {(line) => <div class="break-all font-mono text-[10px] leading-tight text-dls-text">{line}</div>}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.onConfirmWorker && workerDisabled() && workerDisabledReason()}>
        <div class="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-xs text-amber-11">
          <div class="font-semibold text-amber-12">{translate("dashboard.sandbox_get_ready_title")}</div>
          <div class="mt-1 leading-relaxed">{workerDisabledReason() || props.workerCtaDescription?.trim()}</div>
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
            <details class="mt-3 rounded-lg border border-dls-border bg-dls-sidebar px-3 py-2 text-[11px] text-dls-text">
              <summary class="cursor-pointer text-xs font-semibold text-dls-text">Docker debug details</summary>
              <div class="mt-2 space-y-1 break-words font-mono">
                <For each={workerDebugLines()}>{(line) => <div>{line}</div>}</For>
              </div>
            </details>
          </Show>
        </div>
      </Show>

      <div class="flex justify-end gap-3">
        <Show when={showClose()}>
          <button type="button" onClick={props.onClose} disabled={submitting()} class="ow-button-secondary px-4 py-2 text-xs disabled:opacity-50">
            {translate("common.cancel")}
          </button>
        </Show>
        <Show when={props.onConfirmWorker}>
          <button
            type="button"
            onClick={() => props.onConfirmWorker?.(preset(), selectedFolder())}
            disabled={!selectedFolder() || submitting() || workerSubmitting() || workerDisabled()}
            title={!selectedFolder() ? translate("dashboard.choose_folder_continue") : workerDisabledReason() || undefined}
            class="ow-button-secondary px-4 py-2 text-xs disabled:opacity-50"
          >
            <Show when={workerSubmitting()} fallback={props.workerLabel ?? translate("dashboard.create_sandbox_confirm")}>
              <span class="inline-flex items-center gap-2">
                <Loader2 size={16} class="animate-spin" />
                {translate("dashboard.sandbox_checking_docker")}
              </span>
            </Show>
          </button>
        </Show>
        <button
          type="button"
          onClick={() => void handleLocalSubmit()}
          disabled={!selectedFolder() || submitting()}
          title={!selectedFolder() ? translate("dashboard.choose_folder_continue") : undefined}
          class="ow-button-primary px-6 py-2 text-xs disabled:opacity-50"
        >
          <Show when={submitting()} fallback={props.confirmLabel ?? translate("dashboard.create_workspace_confirm")}>
            <span class="inline-flex items-center gap-2">
              <Loader2 size={16} class="animate-spin" />
              Creating...
            </span>
          </Show>
        </button>
      </div>
    </div>
  );

  const remoteFooter = (
    <div class="space-y-3 px-6 py-5">
      <Show when={remoteError()}>
        {(value) => <div class="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-11">{value()}</div>}
      </Show>
      <div class="flex justify-end gap-3">
        <button type="button" class="ow-button-secondary px-4 py-2 text-xs" onClick={props.onClose} disabled={remoteSubmitting()}>
          {translate("common.cancel")}
        </button>
        <button
          type="button"
          class="ow-button-primary px-6 py-2 text-xs disabled:opacity-50"
          disabled={!remoteUrl().trim() || remoteSubmitting()}
          onClick={() => void handleRemoteSubmit()}
        >
          <Show when={remoteSubmitting()} fallback="Connect remote">
            <span class="inline-flex items-center gap-2">
              <Loader2 size={16} class="animate-spin" />
              Connecting...
            </span>
          </Show>
        </button>
      </div>
    </div>
  );

  const body = createMemo(() => {
    switch (screen()) {
      case "local":
        return localBody;
      case "remote":
        return remoteBody;
      case "shared":
        return isSignedIn() ? sharedSignedInBody : sharedSignedOutBody;
      default:
        return chooserBody;
    }
  });

  const footer = createMemo(() => {
    switch (screen()) {
      case "local":
        return localFooter;
      case "remote":
        return remoteFooter;
      default:
        return null;
    }
  });

  const content = (
    <div class={`ow-soft-shell flex max-h-[90vh] w-full ${modalWidthClass()} flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]`}>
      <div class="flex items-start justify-between gap-4 px-6 py-5">
        <div class="flex min-w-0 items-start gap-3">
          <Show when={screen() !== "chooser"}>
            <button
              type="button"
              onClick={() => setScreen("chooser")}
              disabled={submitting() || remoteSubmitting()}
              class={headerButtonClass}
              aria-label="Back"
            >
              <ArrowLeft size={18} />
            </button>
          </Show>
          <div class="min-w-0">
            <h3 class="text-[18px] font-semibold text-dls-text">{headerTitle()}</h3>
            <p class="mt-1 text-sm text-dls-secondary">{headerSubtitle()}</p>
          </div>
        </div>
        <Show when={showClose()}>
          <button
            type="button"
            onClick={props.onClose}
            disabled={submitting() || remoteSubmitting()}
            class={headerButtonClass}
            aria-label="Close add workspace modal"
          >
            <X size={18} />
          </button>
        </Show>
      </div>

      {body()}
      <Show when={footer()}>{(value) => value()}</Show>
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
