import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Cloud,
  ExternalLink,
  FolderPlus,
  Globe,
  Loader2,
  RefreshCcw,
  Search,
  Server,
  X,
} from "lucide-solid";

import { currentLocale, t } from "../../i18n";
import type { WorkspacePreset } from "../types";
import {
  clearDenSession,
  createDenClient,
  DEFAULT_DEN_BASE_URL,
  DenApiError,
  type DenOrgSummary,
  type DenWorkerSummary,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
} from "../lib/den";
import { isDesktopDeployment } from "../lib/openwork-deployment";
import { getOpenWorkDeployment } from "../lib/openwork-deployment";
import { usePlatform } from "../context/platform";

import Button from "./button";
import DesktopOnlyBadge from "./desktop-only-badge";
import TextInput from "./text-input";

type AddWorkspaceScreen = "chooser" | "local" | "remote" | "shared";

type RemoteWorkspaceInput = {
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

type AddWorkspaceModalProps = {
  open: boolean;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
  onCreateLocalWorkspace: (preset: WorkspacePreset, folder: string | null) => Promise<boolean> | boolean;
  onConnectRemoteWorkspace: (input: RemoteWorkspaceInput) => Promise<boolean> | boolean;
  error?: string | null;
  onClearError?: () => void;
};

function workerStatusMeta(status: string) {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "healthy":
      return { label: "Ready", bucket: "ready" as const, canConnect: true };
    case "provisioning":
      return { label: "Starting", bucket: "starting" as const, canConnect: false };
    case "failed":
      return { label: "Needs attention", bucket: "attention" as const, canConnect: false };
    case "stopped":
      return { label: "Stopped", bucket: "neutral" as const, canConnect: false };
    default:
      return {
        label: normalized ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}` : "Unknown",
        bucket: "neutral" as const,
        canConnect: normalized === "ready",
      };
  }
}

function workerStatusBadgeClass(bucket: ReturnType<typeof workerStatusMeta>["bucket"]) {
  switch (bucket) {
    case "ready":
      return "border-emerald-100 bg-emerald-50 text-emerald-600";
    case "starting":
      return "border-amber-100 bg-amber-50 text-amber-600";
    case "attention":
      return "border-rose-100 bg-rose-50 text-rose-600";
    default:
      return "border-gray-100 bg-gray-50 text-gray-500";
  }
}

export default function AddWorkspaceModal(props: AddWorkspaceModalProps) {
  const platform = usePlatform();
  const translate = (key: string) => t(key, currentLocale());
  const localWorkspaceDesktopOnly = getOpenWorkDeployment() === "web";

  const [screen, setScreen] = createSignal<AddWorkspaceScreen>("chooser");
  const [screenError, setScreenError] = createSignal<string | null>(null);

  const [preset, setPreset] = createSignal<WorkspacePreset>("starter");
  const [selectedFolder, setSelectedFolder] = createSignal<string | null>(null);
  const [pickingFolder, setPickingFolder] = createSignal(false);
  const [localSubmitting, setLocalSubmitting] = createSignal(false);

  const [openworkHostUrl, setOpenworkHostUrl] = createSignal("");
  const [openworkToken, setOpenworkToken] = createSignal("");
  const [directory, setDirectory] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [remoteTokenVisible, setRemoteTokenVisible] = createSignal(false);
  const [remoteSubmitting, setRemoteSubmitting] = createSignal(false);

  const [denBaseUrl, setDenBaseUrl] = createSignal(DEFAULT_DEN_BASE_URL);
  const [denAuthToken, setDenAuthToken] = createSignal("");
  const [activeOrgId, setActiveOrgId] = createSignal("");
  const [user, setUser] = createSignal<{ id: string; email: string; name: string | null } | null>(null);
  const [orgs, setOrgs] = createSignal<DenOrgSummary[]>([]);
  const [workers, setWorkers] = createSignal<DenWorkerSummary[]>([]);
  const [workerQuery, setWorkerQuery] = createSignal("");
  const [sessionBusy, setSessionBusy] = createSignal(false);
  const [orgsBusy, setOrgsBusy] = createSignal(false);
  const [workersBusy, setWorkersBusy] = createSignal(false);
  const [openingWorkerId, setOpeningWorkerId] = createSignal<string | null>(null);
  const [sharedNote, setSharedNote] = createSignal<string | null>(null);
  const [sharedAuthError, setSharedAuthError] = createSignal<string | null>(null);
  const [sharedOrgsError, setSharedOrgsError] = createSignal<string | null>(null);
  const [sharedWorkersError, setSharedWorkersError] = createSignal<string | null>(null);

  let chooserRef: HTMLButtonElement | undefined;
  let folderButtonRef: HTMLButtonElement | undefined;
  let remoteUrlRef: HTMLInputElement | undefined;

  const cardClass = "rounded-2xl border border-gray-100 bg-white p-5";
  const softCardClass = "rounded-2xl border border-dls-border bg-dls-surface/70 p-5 shadow-[var(--dls-card-shadow)]";

  const activeOrg = createMemo(() => orgs().find((org) => org.id === activeOrgId()) ?? null);
  const sharedError = createMemo(
    () => screenError() || props.error || sharedAuthError() || sharedOrgsError() || sharedWorkersError(),
  );
  const localError = createMemo(() => screenError() || props.error);
  const remoteError = createMemo(() => screenError() || props.error);
  const closeDisabled = createMemo(
    () => localSubmitting() || remoteSubmitting() || Boolean(openingWorkerId()),
  );
  const sharedSignedIn = createMemo(() => Boolean(user() && denAuthToken().trim()));
  const sharedSessionLoading = createMemo(
    () => Boolean(denAuthToken().trim()) && sessionBusy() && !user(),
  );
  const filteredWorkers = createMemo(() => {
    const query = workerQuery().trim().toLowerCase();
    if (!query) return workers();
    return workers().filter((worker) => {
      const haystack = [worker.workerName, worker.provider ?? "", worker.status]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  });

  const localOptions = createMemo(() => [
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
    {
      id: "automation" as const,
      name: translate("dashboard.blueprints_workspace"),
      desc: translate("dashboard.blueprints_workspace_desc"),
    },
  ]);

  const syncDenSettings = () => {
    const next = readDenSettings();
    setDenBaseUrl(next.baseUrl || DEFAULT_DEN_BASE_URL);
    setDenAuthToken(next.authToken?.trim() || "");
    setActiveOrgId(next.activeOrgId?.trim() || "");
  };

  const clearSharedState = () => {
    setUser(null);
    setOrgs([]);
    setWorkers([]);
    setWorkerQuery("");
    setSharedAuthError(null);
    setSharedOrgsError(null);
    setSharedWorkersError(null);
  };

  const resetModalState = () => {
    setScreen("chooser");
    setScreenError(null);
    props.onClearError?.();
    setPreset("starter");
    setSelectedFolder(null);
    setPickingFolder(false);
    setLocalSubmitting(false);
    setOpenworkHostUrl("");
    setOpenworkToken("");
    setDirectory("");
    setDisplayName("");
    setRemoteTokenVisible(false);
    setRemoteSubmitting(false);
    setOpeningWorkerId(null);
    setSharedNote(null);
    syncDenSettings();
  };

  createEffect(() => {
    if (!props.open) return;
    resetModalState();
    requestAnimationFrame(() => chooserRef?.focus());
  });

  createEffect(() => {
    if (!props.open) return;
    writeDenSettings({
      baseUrl: denBaseUrl(),
      authToken: denAuthToken() || null,
      activeOrgId: activeOrgId() || null,
    });
  });

  createEffect(() => {
    if (!props.open) return;
    const handler = () => {
      syncDenSettings();
      setScreenError(null);
      props.onClearError?.();
    };
    window.addEventListener("openwork-den-session-updated", handler as EventListener);
    onCleanup(() => window.removeEventListener("openwork-den-session-updated", handler as EventListener));
  });

  createEffect(() => {
    if (!props.open || screen() !== "chooser") return;
    requestAnimationFrame(() => chooserRef?.focus());
  });

  createEffect(() => {
    if (!props.open || screen() !== "local") return;
    requestAnimationFrame(() => folderButtonRef?.focus());
  });

  createEffect(() => {
    if (!props.open || screen() !== "remote") return;
    requestAnimationFrame(() => remoteUrlRef?.focus());
  });

  const navigateTo = (next: AddWorkspaceScreen) => {
    setScreenError(null);
    props.onClearError?.();
    setSharedNote(null);
    setScreen(next);
  };

  const backToChooser = () => {
    navigateTo("chooser");
  };

  const handleClose = () => {
    if (closeDisabled()) return;
    props.onClearError?.();
    props.onClose();
  };

  const handlePickFolder = async () => {
    if (pickingFolder() || localSubmitting()) return;
    setScreenError(null);
    props.onClearError?.();
    setPickingFolder(true);
    try {
      const next = await props.onPickFolder();
      if (next) setSelectedFolder(next);
    } finally {
      setPickingFolder(false);
    }
  };

  const handleCreateLocalWorkspace = async () => {
    if (localSubmitting()) return;
    setScreenError(null);
    props.onClearError?.();
    setLocalSubmitting(true);
    try {
      const ok = await props.onCreateLocalWorkspace(preset(), selectedFolder());
      if (ok) {
        props.onClose();
        return;
      }
      setScreenError((prev) => prev ?? "Failed to create workspace.");
    } finally {
      setLocalSubmitting(false);
    }
  };

  const handleConnectCustomRemote = async () => {
    if (remoteSubmitting()) return;
    setScreenError(null);
    props.onClearError?.();
    setRemoteSubmitting(true);
    try {
      const ok = await props.onConnectRemoteWorkspace({
        openworkHostUrl: openworkHostUrl().trim(),
        openworkToken: openworkToken().trim(),
        directory: directory().trim() || null,
        displayName: displayName().trim() || null,
      });
      if (ok) {
        props.onClose();
        return;
      }
      setScreenError((prev) => prev ?? "Failed to connect remote workspace.");
    } finally {
      setRemoteSubmitting(false);
    }
  };

  const refreshOrgs = async (quiet = false) => {
    const token = denAuthToken().trim();
    if (!token) {
      setOrgs([]);
      setActiveOrgId("");
      return;
    }

    setOrgsBusy(true);
    if (!quiet) setSharedOrgsError(null);

    try {
      const response = await createDenClient({ baseUrl: denBaseUrl(), token }).listOrgs();
      setOrgs(response.orgs);
      const current = activeOrgId().trim();
      const fallback = response.defaultOrgId ?? response.orgs[0]?.id ?? "";
      setActiveOrgId(response.orgs.some((org) => org.id === current) ? current : fallback);
      if (!quiet && response.orgs.length > 0) {
        setSharedNote(`Loaded ${response.orgs.length} org${response.orgs.length === 1 ? "" : "s"}.`);
      }
    } catch (error) {
      setSharedOrgsError(error instanceof Error ? error.message : "Failed to load organizations.");
    } finally {
      setOrgsBusy(false);
    }
  };

  const refreshWorkers = async (quiet = false) => {
    const token = denAuthToken().trim();
    const orgId = activeOrgId().trim();
    if (!token || !orgId) {
      setWorkers([]);
      return;
    }

    setWorkersBusy(true);
    if (!quiet) setSharedWorkersError(null);

    try {
      const nextWorkers = await createDenClient({ baseUrl: denBaseUrl(), token }).listWorkers(orgId, 20);
      setWorkers(nextWorkers);
      if (!quiet) {
        setSharedNote(
          nextWorkers.length > 0
            ? `Loaded ${nextWorkers.length} shared workspace${nextWorkers.length === 1 ? "" : "s"}.`
            : "No shared workspaces found for this org.",
        );
      }
    } catch (error) {
      setSharedWorkersError(error instanceof Error ? error.message : "Failed to load shared workspaces.");
    } finally {
      setWorkersBusy(false);
    }
  };

  createEffect(() => {
    if (!props.open || screen() !== "shared") return;

    const token = denAuthToken().trim();
    const currentBaseUrl = denBaseUrl();
    let cancelled = false;

    if (!token) {
      setSessionBusy(false);
      clearSharedState();
      return;
    }

    setSessionBusy(true);
    setSharedAuthError(null);

    void createDenClient({ baseUrl: currentBaseUrl, token })
      .getSession()
      .then((nextUser) => {
        if (cancelled) return;
        setUser(nextUser);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DenApiError && error.status === 401) {
          clearDenSession({ includeBaseUrls: false });
          setDenAuthToken("");
          setActiveOrgId("");
        }
        clearSharedState();
        setSharedAuthError(error instanceof Error ? error.message : "No active Cloud session found.");
      })
      .finally(() => {
        if (!cancelled) setSessionBusy(false);
      });

    return () => {
      cancelled = true;
    };
  });

  createEffect(() => {
    if (!props.open || screen() !== "shared" || !user()) return;
    void refreshOrgs(true);
  });

  createEffect(() => {
    if (!props.open || screen() !== "shared" || !user() || !activeOrgId().trim()) return;
    void refreshWorkers(true);
  });

  const openBrowserAuth = (mode: "sign-in" | "sign-up") => {
    const target = new URL(resolveDenBaseUrls(denBaseUrl()).baseUrl);
    target.searchParams.set("mode", mode);
    if (isDesktopDeployment()) {
      target.searchParams.set("desktopAuth", "1");
      target.searchParams.set("desktopScheme", "openwork");
    }
    platform.openLink(target.toString());
    setSharedNote(
      mode === "sign-up"
        ? "Finish account creation in your browser. OpenWork will reconnect here automatically."
        : "Finish signing in in your browser. OpenWork will reconnect here automatically.",
    );
    setSharedAuthError(null);
  };

  const openCloudDashboard = () => {
    const base = resolveDenBaseUrls(denBaseUrl()).baseUrl.replace(/\/+$/, "");
    const org = activeOrg();
    const target = org?.slug
      ? `${base}/o/${encodeURIComponent(org.slug)}/dashboard/background-agents`
      : base;
    platform.openLink(target);
  };

  const handleConnectSharedWorker = async (worker: DenWorkerSummary) => {
    const orgId = activeOrgId().trim();
    if (!orgId || openingWorkerId()) return;

    setScreenError(null);
    props.onClearError?.();
    setSharedWorkersError(null);
    setOpeningWorkerId(worker.workerId);

    try {
      const tokens = await createDenClient({ baseUrl: denBaseUrl(), token: denAuthToken() }).getWorkerTokens(
        worker.workerId,
        orgId,
      );
      const openworkUrl = tokens.openworkUrl?.trim() ?? "";
      const accessToken = tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
      if (!openworkUrl || !accessToken) {
        throw new Error("Shared workspace is not ready to connect yet.");
      }

      const ok = await props.onConnectRemoteWorkspace({
        openworkHostUrl: openworkUrl,
        openworkToken: accessToken,
        directory: null,
        displayName: worker.workerName,
      });
      if (!ok) {
        throw new Error(`Failed to open ${worker.workerName}.`);
      }

      props.onClose();
    } catch (error) {
      setSharedWorkersError(error instanceof Error ? error.message : "Failed to connect shared workspace.");
    } finally {
      setOpeningWorkerId(null);
    }
  };

  const chooserCardClass = (disabled = false) =>
    `group w-full rounded-2xl border border-gray-100 bg-white p-5 text-left transition-all ${
      disabled
        ? "cursor-not-allowed opacity-60"
        : "hover:border-gray-200 hover:shadow-[0_2px_8px_-4px_rgba(0,0,0,0.04)]"
    }`;

  const header = (
    <div class="flex items-start justify-between gap-4 border-b border-dls-border px-6 py-5 bg-dls-surface">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <Show when={screen() !== "chooser"}>
            <button
              type="button"
              class="-ml-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={backToChooser}
              disabled={closeDisabled()}
              aria-label="Back"
            >
              <ArrowLeft size={18} />
            </button>
          </Show>
          <div class="min-w-0">
            <h3 class="text-[18px] font-semibold text-dls-text">
              {screen() === "chooser"
                ? "Add workspace"
                : screen() === "local"
                  ? "Local workspace"
                  : screen() === "remote"
                    ? "Connect custom remote"
                    : "Shared workspaces"}
            </h3>
            <p class="mt-1 text-sm text-dls-secondary">
              {screen() === "chooser"
                ? "Choose where this workspace should run."
                : screen() === "local"
                  ? "Create a folder-based workspace on this device."
                  : screen() === "remote"
                    ? "Attach to a self-hosted OpenWork worker."
                    : "Connect to a cloud-managed workspace from your team."}
            </p>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={handleClose}
        disabled={closeDisabled()}
        class={`inline-flex h-8 w-8 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text ${closeDisabled() ? "cursor-not-allowed opacity-50" : ""}`.trim()}
        aria-label="Close add workspace modal"
      >
        <X size={18} />
      </button>
    </div>
  );

  const chooserScreen = (
    <div class="space-y-3 px-6 py-6">
      <button
        type="button"
        ref={chooserRef}
        class={chooserCardClass(localWorkspaceDesktopOnly)}
        onClick={() => {
          if (localWorkspaceDesktopOnly) return;
          navigateTo("local");
        }}
      >
        <div class="flex items-start gap-4">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-100 bg-gray-50 text-gray-11">
            <FolderPlus size={18} />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-[15px] font-semibold text-dls-text">
              <span>New local workspace</span>
              <Show when={localWorkspaceDesktopOnly}>
                <DesktopOnlyBadge />
              </Show>
            </div>
            <p class="mt-1 text-[13px] text-dls-secondary">Run completely on this device with the standard local workspace flow.</p>
          </div>
          <ArrowRight size={16} class="mt-1 shrink-0 text-gray-9" />
        </div>
      </button>

      <button type="button" class={chooserCardClass()} onClick={() => navigateTo("remote")}>
        <div class="flex items-start gap-4">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-100 bg-gray-50 text-gray-11">
            <Server size={18} />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[15px] font-semibold text-dls-text">Connect custom remote</div>
            <p class="mt-1 text-[13px] text-dls-secondary">Attach to a self-hosted OpenWork worker you manage.</p>
          </div>
          <ArrowRight size={16} class="mt-1 shrink-0 text-gray-9" />
        </div>
      </button>

      <button type="button" class={chooserCardClass()} onClick={() => navigateTo("shared")}>
        <div class="flex items-start gap-4">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-100 bg-gray-50 text-gray-11">
            <Cloud size={18} />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[15px] font-semibold text-dls-text">Shared workspaces</div>
            <p class="mt-1 text-[13px] text-dls-secondary">Connect to OpenWork Cloud workers managed by your organization.</p>
          </div>
          <ArrowRight size={16} class="mt-1 shrink-0 text-gray-9" />
        </div>
      </button>
    </div>
  );

  const localScreen = (
    <>
      <div class="space-y-6 px-6 py-6">
        <div class="space-y-4">
          <div class="flex items-center gap-3 text-sm font-medium text-gray-12">
            <div class="flex h-6 w-6 items-center justify-center rounded-full bg-gray-4 text-xs">1</div>
            {translate("dashboard.select_folder")}
          </div>
          <div class="ml-9">
            <button
              type="button"
              ref={folderButtonRef}
              onClick={() => void handlePickFolder()}
              disabled={pickingFolder() || localSubmitting()}
              class={`w-full rounded-xl border border-dashed border-gray-7 bg-gray-2/50 p-4 text-left transition ${pickingFolder() ? "cursor-wait opacity-70" : "hover:border-gray-8"}`.trim()}
            >
              <div class="flex items-center gap-3 text-gray-12">
                <FolderPlus size={20} class="text-gray-11" />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium text-gray-12">
                    {selectedFolder()?.trim() || translate("dashboard.choose_folder")}
                  </div>
                  <div class="mt-1 truncate font-mono text-xs text-gray-10">
                    {selectedFolder()?.trim() || translate("dashboard.choose_folder_next")}
                  </div>
                </div>
                <Show
                  when={pickingFolder()}
                  fallback={<span class="text-xs text-gray-10">{translate("dashboard.change")}</span>}
                >
                  <span class="inline-flex items-center gap-2 text-xs text-gray-10">
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
            <div class="flex h-6 w-6 items-center justify-center rounded-full bg-gray-4 text-xs">2</div>
            {translate("dashboard.choose_preset")}
          </div>
          <div class={`ml-9 grid gap-3 ${!selectedFolder() ? "opacity-50" : ""}`.trim()}>
            <For each={localOptions()}>
              {(option) => (
                <button
                  type="button"
                  onClick={() => {
                    if (!selectedFolder() || localSubmitting()) return;
                    setPreset(option.id);
                  }}
                  disabled={!selectedFolder() || localSubmitting()}
                  class={`rounded-xl border p-4 text-left transition-all ${preset() === option.id ? "border-indigo-7/50 bg-indigo-7/10" : "border-gray-6 bg-gray-2 hover:border-gray-7"}`.trim()}
                >
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class={`text-sm font-medium ${preset() === option.id ? "text-indigo-11" : "text-gray-12"}`.trim()}>{option.name}</div>
                      <div class="mt-1 text-xs text-gray-10">{option.desc}</div>
                    </div>
                    <div class={`mt-0.5 h-4 w-4 rounded-full border ${preset() === option.id ? "border-indigo-7 bg-indigo-7 shadow-[inset_0_0_0_3px_white]" : "border-gray-7 bg-white"}`.trim()} />
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>

      <div class="space-y-3 border-t border-dls-border bg-dls-surface px-6 py-5">
        <Show when={localError()}>
          {(value) => <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}
        </Show>
        <div class="flex justify-end gap-3">
          <Button variant="ghost" onClick={handleClose} disabled={localSubmitting()}>
            {translate("common.cancel")}
          </Button>
          <Button
            onClick={() => void handleCreateLocalWorkspace()}
            disabled={!selectedFolder() || localSubmitting()}
            title={!selectedFolder() ? translate("dashboard.choose_folder_continue") : undefined}
          >
            <Show when={localSubmitting()} fallback={translate("dashboard.create_workspace_confirm")}>
              <span class="inline-flex items-center gap-2">
                <Loader2 size={16} class="animate-spin" />
                Creating...
              </span>
            </Show>
          </Button>
        </div>
      </div>
    </>
  );

  const remoteScreen = (
    <>
      <div class="space-y-6 px-6 py-6">
        <div class="rounded-2xl border border-gray-6 bg-gray-1/40 p-4 flex items-center gap-3">
          <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-3 text-gray-12">
            <Globe size={20} />
          </div>
          <div>
            <div class="text-sm font-medium text-gray-12">Remote worker details</div>
            <div class="text-xs text-gray-10">Use this for self-hosted OpenWork workers outside your team cloud list.</div>
          </div>
        </div>

        <div class="space-y-4">
          <TextInput
            ref={remoteUrlRef}
            label={translate("dashboard.openwork_host_label")}
            placeholder={translate("dashboard.openwork_host_placeholder")}
            value={openworkHostUrl()}
            onInput={(event) => setOpenworkHostUrl(event.currentTarget.value)}
            hint={translate("dashboard.openwork_host_hint")}
            disabled={remoteSubmitting()}
          />

          <label class="block">
            <div class="mb-1 text-xs font-medium text-dls-secondary">{translate("dashboard.openwork_host_token_label")}</div>
            <div class="flex items-center gap-2">
              <input
                type={remoteTokenVisible() ? "text" : "password"}
                value={openworkToken()}
                onInput={(event) => setOpenworkToken(event.currentTarget.value)}
                placeholder={translate("dashboard.openwork_host_token_placeholder")}
                disabled={remoteSubmitting()}
                class="w-full rounded-xl border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text placeholder:text-dls-secondary shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              />
              <Button
                variant="outline"
                class="h-9 shrink-0 px-3 text-xs"
                onClick={() => setRemoteTokenVisible((prev) => !prev)}
                disabled={remoteSubmitting()}
              >
                {remoteTokenVisible() ? translate("common.hide") : translate("common.show")}
              </Button>
            </div>
            <div class="mt-1 text-xs text-dls-secondary">{translate("dashboard.openwork_host_token_hint")}</div>
          </label>

          <TextInput
            label={translate("dashboard.remote_directory_label")}
            placeholder={translate("dashboard.remote_directory_placeholder")}
            value={directory()}
            onInput={(event) => setDirectory(event.currentTarget.value)}
            hint={translate("dashboard.remote_directory_hint")}
            disabled={remoteSubmitting()}
          />

          <TextInput
            label={translate("dashboard.remote_display_name_label")}
            placeholder={translate("dashboard.remote_display_name_placeholder")}
            value={displayName()}
            onInput={(event) => setDisplayName(event.currentTarget.value)}
            disabled={remoteSubmitting()}
          />
        </div>
      </div>

      <div class="space-y-3 border-t border-dls-border bg-dls-surface px-6 py-5">
        <Show when={remoteError()}>
          {(value) => <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}
        </Show>
        <div class="flex justify-end gap-3">
          <Button variant="ghost" onClick={handleClose} disabled={remoteSubmitting()}>
            {translate("common.cancel")}
          </Button>
          <Button
            onClick={() => void handleConnectCustomRemote()}
            disabled={remoteSubmitting() || !openworkHostUrl().trim()}
            title={!openworkHostUrl().trim() ? translate("dashboard.remote_base_url_required") : undefined}
          >
            <Show when={remoteSubmitting()} fallback="Connect remote">
              <span class="inline-flex items-center gap-2">
                <Loader2 size={16} class="animate-spin" />
                Connecting...
              </span>
            </Show>
          </Button>
        </div>
      </div>
    </>
  );

  const sharedSignedOut = (
    <div class="space-y-4 px-6 py-6">
      <div class={`${softCardClass} space-y-4`}>
        <div class="flex items-start gap-3">
          <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-dls-accent/10 text-dls-accent">
            <Cloud size={20} />
          </div>
          <div>
            <div class="text-sm font-medium text-dls-text">Sign in to OpenWork Cloud</div>
            <div class="mt-1 text-sm leading-relaxed text-dls-secondary">Access remote workspaces shared with your organization, then connect directly inside OpenWork.</div>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => openBrowserAuth("sign-in")}>
            Continue with Cloud
            <ArrowRight size={14} />
          </Button>
          <Button variant="outline" onClick={() => openBrowserAuth("sign-up")}>
            Create account
            <ExternalLink size={14} />
          </Button>
        </div>
      </div>

      <Show when={sharedError()}>
        {(value) => <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}
      </Show>
      <Show when={sharedNote()}>
        {(value) => <div class="rounded-xl border border-gray-6/60 bg-gray-1/50 px-3 py-2 text-xs text-gray-11">{value()}</div>}
      </Show>
    </div>
  );

  const sharedSignedInScreen = (
    <div class="space-y-4 px-6 py-6">
      <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div class="min-w-0">
          <div class="text-sm font-medium text-dls-text">{user()?.name || user()?.email}</div>
          <div class="mt-1 text-xs text-dls-secondary">Choose an organization and connect to a running shared workspace.</div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" class="h-8 px-3 text-xs" onClick={() => void refreshOrgs()} disabled={orgsBusy() || workersBusy()}>
            <RefreshCcw size={13} class={orgsBusy() || workersBusy() ? "animate-spin" : ""} />
            Refresh
          </Button>
          <Button variant="ghost" class="h-8 px-3 text-xs" onClick={openCloudDashboard}>
            Open cloud dashboard
            <ExternalLink size={13} />
          </Button>
        </div>
      </div>

      <Show when={sharedError()}>
        {(value) => <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">{value()}</div>}
      </Show>
      <Show when={!sharedError() && sharedNote()}>
        {(value) => <div class="rounded-xl border border-gray-6/60 bg-gray-1/50 px-3 py-2 text-xs text-gray-11">{value()}</div>}
      </Show>

      <div class="grid gap-3 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <label class="block">
          <div class="mb-1 text-xs font-medium text-dls-secondary">Organization</div>
          <select
            class="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
            value={activeOrgId()}
            onChange={(event) => {
              const nextOrgId = event.currentTarget.value;
              const nextOrg = orgs().find((org) => org.id === nextOrgId) ?? null;
              setActiveOrgId(nextOrgId);
              setSharedWorkersError(null);
              setSharedNote(`Switched to ${nextOrg?.name ?? "the selected organization"}.`);
            }}
            disabled={orgsBusy() || orgs().length === 0}
          >
            <For each={orgs()}>
              {(org) => <option value={org.id}>{org.name} {org.role === "owner" ? "(Owner)" : "(Member)"}</option>}
            </For>
          </select>
        </label>

        <label class="block">
          <div class="mb-1 text-xs font-medium text-dls-secondary">Search</div>
          <div class="relative">
            <div class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-9">
              <Search size={14} />
            </div>
            <input
              type="text"
              value={workerQuery()}
              onInput={(event) => setWorkerQuery(event.currentTarget.value)}
              placeholder="Search shared workspaces"
              class="w-full rounded-lg border border-dls-border bg-dls-surface py-2 pl-9 pr-3 text-sm text-dls-text shadow-sm placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
            />
          </div>
        </label>
      </div>

      <div class="space-y-3">
      <Show when={sharedSessionLoading() || (workersBusy() && workers().length === 0)}>
        <div class={`${cardClass} text-sm text-gray-10`}>Loading shared workspaces...</div>
      </Show>

        <Show when={!sessionBusy() && !workersBusy() && activeOrgId().trim() && filteredWorkers().length === 0}>
          <div class={`${cardClass} text-sm text-gray-10`}>
            {workerQuery().trim()
              ? "No shared workspaces match that search."
              : "No shared workspaces are available for this organization yet."}
          </div>
        </Show>

        <Show when={!sessionBusy() && !activeOrgId().trim() && orgs().length === 0 && !orgsBusy()}>
          <div class={`${cardClass} text-sm text-gray-10`}>No organizations are available for this account yet.</div>
        </Show>

        <For each={filteredWorkers()}>
          {(worker) => {
            const meta = createMemo(() => workerStatusMeta(worker.status));
            const opening = createMemo(() => openingWorkerId() === worker.workerId);
            return (
              <div class="rounded-2xl border border-gray-100 bg-white p-5 transition-all hover:border-gray-200 hover:shadow-[0_2px_8px_-4px_rgba(0,0,0,0.04)]">
                <div class="flex items-start justify-between gap-4">
                  <div class="flex min-w-0 items-center gap-4">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-100 bg-gray-50 text-gray-10">
                      <Box size={18} />
                    </div>
                    <div class="min-w-0">
                      <div class="mb-0.5 flex flex-wrap items-center gap-2 text-[14px] font-medium text-gray-12">
                        <span class="truncate">{worker.workerName}</span>
                        <span class={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.5px] ${workerStatusBadgeClass(meta().bucket)}`.trim()}>
                          <span class="h-1.5 w-1.5 rounded-full bg-current" />
                          {meta().label}
                        </span>
                      </div>
                      <div class="truncate text-[12px] text-gray-400">
                        Source: {worker.provider ? `${worker.provider} sandbox` : "cloud sandbox"}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    class="h-8 shrink-0 px-3 text-xs"
                    onClick={() => void handleConnectSharedWorker(worker)}
                    disabled={opening() || !meta().canConnect || Boolean(openingWorkerId())}
                    title={!meta().canConnect ? "This shared workspace is not ready to connect yet." : undefined}
                  >
                    <Show when={opening()} fallback="Connect">
                      <span class="inline-flex items-center gap-2">
                        <Loader2 size={14} class="animate-spin" />
                        Connecting...
                      </span>
                    </Show>
                  </Button>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-gray-1/60 p-4 backdrop-blur-sm animate-in fade-in duration-200">
        <div class={`ow-soft-shell flex max-h-[90vh] w-full flex-col overflow-hidden rounded-[24px] bg-[#fbfbfc] ${screen() === "shared" ? "max-w-2xl" : "max-w-lg"}`.trim()}>
          {header}
          <Show when={screen() === "chooser"}>{chooserScreen}</Show>
          <Show when={screen() === "local"}>{localScreen}</Show>
          <Show when={screen() === "remote"}>{remoteScreen}</Show>
          <Show when={screen() === "shared"}>
            <Show
              when={!sharedSessionLoading()}
              fallback={
                <div class="px-6 py-6">
                  <div class={`${softCardClass} flex items-center gap-3 text-sm text-dls-secondary`}>
                    <Loader2 size={16} class="animate-spin" />
                    Checking your OpenWork Cloud session...
                  </div>
                </div>
              }
            >
              <Show when={sharedSignedIn()} fallback={sharedSignedOut}>
                {sharedSignedInScreen}
              </Show>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}
