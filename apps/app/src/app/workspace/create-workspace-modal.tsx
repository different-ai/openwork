import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { ArrowLeft, Cloud, FolderPlus, Globe, Loader2, X } from "lucide-solid";

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
import {
  loadDenTemplateCache,
  readDenTemplateCacheSnapshot,
} from "../lib/den-template-cache";
import type { WorkspacePreset } from "../types";
import CreateWorkspaceLocalPanel from "./create-workspace-local-panel";
import CreateWorkspaceSharedPanel from "./create-workspace-shared-panel";
import {
  modalBodyClass,
  modalHeaderButtonClass,
  modalHeaderClass,
  modalOverlayClass,
  modalShellClass,
  modalSubtitleClass,
  modalTitleClass,
  pillGhostClass,
  pillPrimaryClass,
  tagClass,
} from "./modal-styles";
import WorkspaceOptionCard from "./option-card";
import RemoteWorkspaceFields from "./remote-workspace-fields";
import type {
  CreateWorkspaceModalProps,
  CreateWorkspaceScreen,
  RemoteWorkspaceInput,
} from "./types";

function workerStatusMeta(status: string, translate: (key: string) => string) {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "healthy":
      return { label: translate("dashboard.worker_status_ready"), tone: "ready" as const, canOpen: true };
    case "provisioning":
    case "starting":
      return { label: translate("dashboard.worker_status_starting"), tone: "warning" as const, canOpen: false };
    case "failed":
    case "error":
      return { label: translate("dashboard.worker_status_attention"), tone: "error" as const, canOpen: false };
    case "stopped":
      return { label: translate("dashboard.worker_status_stopped"), tone: "neutral" as const, canOpen: false };
    default:
      return {
        label: normalized
          ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`
          : translate("common.unknown"),
        tone: "neutral" as const,
        canOpen: normalized === "ready",
      };
  }
}

function formatTemplateTimestamp(value: string | null, translate: (key: string) => string) {
  if (!value) return translate("dashboard.recently_updated");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return translate("dashboard.recently_updated");
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function templateCreatorLabel(template: DenTemplate, translate: (key: string) => string) {
  const creator = template.creator;
  if (!creator) return translate("dashboard.unknown_creator");
  return creator.name?.trim() || creator.email?.trim() || translate("dashboard.unknown_creator");
}

function workerSecondaryLine(worker: DenWorkerSummary, translate: (key: string) => string) {
  const parts = [worker.provider?.trim() || translate("dashboard.cloud_worker")];
  if (worker.instanceUrl?.trim()) parts.push(worker.instanceUrl.trim());
  return parts.join(" · ");
}

export default function CreateWorkspaceModal(props: CreateWorkspaceModalProps) {
  let remoteUrlRef: HTMLInputElement | undefined;
  const translate = (key: string, params?: Record<string, string | number>) => t(key, currentLocale(), params);
  const platform = usePlatform();

  const [screen, setScreen] = createSignal<CreateWorkspaceScreen>("chooser");
  const [preset] = createSignal<WorkspacePreset>(props.defaultPreset ?? "starter");
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
  const workerDebugLines = createMemo(() =>
    (props.workerDebugLines ?? []).map((line) => line.trim()).filter(Boolean),
  );
  const hasSelectedFolder = createMemo(() => Boolean(selectedFolder()?.trim()));
  const remoteError = createMemo(() => (props.remoteError ?? "").trim() || null);
  const isSignedIn = createMemo(() => Boolean(cloudSettings().authToken?.trim()));
  const denClient = createMemo(
    () => createDenClient({ baseUrl: cloudSettings().baseUrl, token: cloudSettings().authToken ?? "" }),
  );
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
      return Boolean(
        payload &&
          typeof payload === "object" &&
          (payload as { type?: unknown }).type === "workspace-profile",
      );
    }),
  );
  const showTemplateSection = createMemo(
    () =>
      Boolean(
        props.onConfirmTemplate &&
          cloudSettings().authToken?.trim() &&
          cloudSettings().activeOrgSlug?.trim(),
      ),
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

  const modalWidthClass = createMemo(() =>
    screen() === "shared" ? "max-w-[640px]" : "max-w-[560px]",
  );

  const headerTitle = createMemo(() => {
    switch (screen()) {
      case "local":
        return translate("dashboard.create_local_workspace_title");
      case "remote":
        return translate("dashboard.create_remote_custom_title");
      case "shared":
        return translate("dashboard.create_shared_title");
      default:
        return props.title ?? translate("dashboard.create_workspace_title");
    }
  });

  const headerSubtitle = createMemo(() => {
    switch (screen()) {
      case "local":
        return translate("dashboard.create_local_workspace_subtitle");
      case "remote":
        return translate("dashboard.create_remote_custom_subtitle");
      case "shared":
        return isSignedIn()
          ? translate("dashboard.create_shared_subtitle_signed_in")
          : translate("dashboard.create_shared_subtitle_signed_out");
      default:
        return props.subtitle ?? translate("dashboard.create_workspace_subtitle");
    }
  });

  createEffect(() => {
    if (props.open) {
      const settings = readDenSettings();
      setScreen("chooser");
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
    onCleanup(() =>
      window.removeEventListener("openwork-den-session-updated", handler as EventListener),
    );
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
      setOrgsError(
        error instanceof Error ? error.message : translate("dashboard.error_load_orgs"),
      );
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
      setWorkersError(
        error instanceof Error ? error.message : translate("dashboard.error_load_shared_workspaces"),
      );
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
      setWorkersError(translate("dashboard.error_choose_org"));
      return;
    }
    setOpeningWorkerId(worker.workerId);
    setWorkersError(null);
    try {
      const tokens = await denClient().getWorkerTokens(worker.workerId, orgId);
      const openworkUrl = tokens.openworkUrl?.trim() ?? "";
      const accessToken =
        tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
      if (!openworkUrl || !accessToken) {
        throw new Error(translate("dashboard.error_workspace_not_ready"));
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
        throw new Error(translate("dashboard.error_connect_worker", { name: worker.workerName }));
      }
    } catch (error) {
      setWorkersError(
        error instanceof Error
          ? error.message
          : translate("dashboard.error_connect_worker", { name: worker.workerName }),
      );
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
        setTemplateError(
          error instanceof Error
            ? error.message
            : translate("dashboard.error_create_template", { name: template.name }),
        );
      }
      return;
    }
    props.onConfirm(preset(), selectedFolder());
  };

  const content = (
    <div class={`${modalShellClass} ${modalWidthClass()}`}>
      <div class={modalHeaderClass}>
        <div class="flex min-w-0 items-start gap-3">
          <Show when={screen() !== "chooser"}>
            <button
              type="button"
              onClick={() => setScreen("chooser")}
              disabled={submitting() || remoteSubmitting()}
              class={modalHeaderButtonClass}
              aria-label={translate("dashboard.modal_back")}
            >
              <ArrowLeft size={18} />
            </button>
          </Show>
          <div class="min-w-0">
            <h3 class={modalTitleClass}>{headerTitle()}</h3>
            <p class={modalSubtitleClass}>{headerSubtitle()}</p>
          </div>
        </div>
        <Show when={showClose()}>
          <button
            type="button"
            onClick={props.onClose}
            disabled={submitting() || remoteSubmitting()}
            class={modalHeaderButtonClass}
            aria-label={translate("dashboard.modal_close")}
          >
            <X size={18} />
          </button>
        </Show>
      </div>

      <Show when={screen() === "chooser"}>
        <div class={modalBodyClass}>
          <div class="space-y-3">
            <WorkspaceOptionCard
              title={translate("dashboard.create_local_workspace_title")}
              description={
                props.localDisabled
                  ? props.localDisabledReason?.trim() || translate("dashboard.chooser_local_desc")
                  : translate("dashboard.chooser_local_desc")
              }
              icon={FolderPlus}
              onClick={() => setScreen("local")}
              disabled={props.localDisabled}
              endAdornment={props.localDisabled ? <span class={tagClass}>{translate("dashboard.desktop_badge")}</span> : undefined}
            />
            <WorkspaceOptionCard
              title={translate("dashboard.create_remote_custom_title")}
              description={translate("dashboard.chooser_remote_desc")}
              icon={Globe}
              onClick={() => setScreen("remote")}
            />
            <WorkspaceOptionCard
              title={translate("dashboard.create_shared_title")}
              description={translate("dashboard.chooser_shared_desc")}
              icon={Cloud}
              onClick={() => setScreen("shared")}
            />

            <Show when={props.onImportConfig}>
              <div class="pt-2">
                <button
                  type="button"
                  onClick={() => props.onImportConfig?.()}
                  disabled={props.importingConfig}
                  class={pillGhostClass}
                >
                  <Show when={props.importingConfig} fallback={translate("dashboard.import_config")}>
                    <span class="inline-flex items-center gap-2">
                      <Loader2 size={14} class="animate-spin" />
                      {translate("dashboard.importing")}
                    </span>
                  </Show>
                </button>
              </div>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={screen() === "local"}>
        <CreateWorkspaceLocalPanel
          translate={translate}
          selectedFolder={selectedFolder()}
          hasSelectedFolder={hasSelectedFolder()}
          pickingFolder={pickingFolder()}
          onPickFolder={() => void handlePickFolder()}
          submitting={submitting()}
          selectedTemplateId={selectedTemplateId()}
          setSelectedTemplateId={setSelectedTemplateId}
          showTemplateSection={showTemplateSection()}
          cloudWorkspaceTemplates={cloudWorkspaceTemplates()}
          templateCreatorLabel={(template) => templateCreatorLabel(template, translate)}
          formatTemplateTimestamp={(value) => formatTemplateTimestamp(value, translate)}
          templateError={templateError()}
          templateCacheBusy={templateCacheSnapshot().busy}
          templateCacheError={templateCacheSnapshot().error}
          onClose={props.onClose}
          onSubmit={() => void handleLocalSubmit()}
          confirmLabel={props.confirmLabel}
          workerLabel={props.workerLabel}
          onConfirmWorker={props.onConfirmWorker}
          preset={preset()}
          workerSubmitting={workerSubmitting()}
          workerDisabled={workerDisabled()}
          workerDisabledReason={workerDisabledReason()}
          workerCtaLabel={props.workerCtaLabel}
          workerCtaDescription={props.workerCtaDescription}
          onWorkerCta={props.onWorkerCta}
          workerRetryLabel={props.workerRetryLabel}
          onWorkerRetry={props.onWorkerRetry}
          workerDebugLines={workerDebugLines()}
          progress={progress()}
          elapsedSeconds={elapsedSeconds()}
          showProgressDetails={showProgressDetails()}
          onToggleProgressDetails={() => setShowProgressDetails((prev) => !prev)}
        />
      </Show>

      <Show when={screen() === "remote"}>
        <>
          <div class={modalBodyClass}>
            <RemoteWorkspaceFields
              hostUrl={remoteUrl()}
              onHostUrlInput={setRemoteUrl}
              token={remoteToken()}
              tokenVisible={remoteTokenVisible()}
              onTokenInput={setRemoteToken}
              onToggleTokenVisible={() => setRemoteTokenVisible((prev) => !prev)}
              displayName={remoteDisplayName()}
              onDisplayNameInput={setRemoteDisplayName}
              submitting={remoteSubmitting()}
              hostInputRef={remoteUrlRef}
              title={translate("dashboard.remote_server_details_title")}
              description={translate("dashboard.remote_server_details_hint")}
            />
          </div>
          <div class="space-y-3 border-t border-dls-border px-6 py-5">
            <Show when={remoteError()}>{(value) => <div class="rounded-[20px] border border-red-7/20 bg-red-1/40 px-4 py-3 text-[13px] text-red-11">{value()}</div>}</Show>
            <div class="flex justify-end gap-3">
              <button type="button" class={pillGhostClass} onClick={props.onClose} disabled={remoteSubmitting()}>
                {translate("common.cancel")}
              </button>
              <button
                type="button"
                class={pillPrimaryClass}
                disabled={!remoteUrl().trim() || remoteSubmitting()}
                onClick={() => void handleRemoteSubmit()}
              >
                <Show when={remoteSubmitting()} fallback={translate("dashboard.connect_remote_button")}>
                  <span class="inline-flex items-center gap-2">
                    <Loader2 size={16} class="animate-spin" />
                    {translate("dashboard.connecting")}
                  </span>
                </Show>
              </button>
            </div>
          </div>
        </>
      </Show>

      <Show when={screen() === "shared"}>
        <CreateWorkspaceSharedPanel
          signedIn={isSignedIn()}
          orgs={orgs()}
          activeOrgId={activeOrgId()}
          onActiveOrgChange={(orgId) => {
            const nextOrg = orgs().find((org) => org.id === orgId) ?? null;
            applyActiveOrg(nextOrg);
          }}
          orgsBusy={orgsBusy()}
          orgsError={orgsError()}
          workers={workers()}
          workersBusy={workersBusy()}
          workersError={workersError()}
          workerSearch={workerSearch()}
          onWorkerSearchInput={setWorkerSearch}
          filteredWorkers={filteredWorkers()}
          openingWorkerId={openingWorkerId()}
          workerStatusMeta={(status) => workerStatusMeta(status, translate)}
          workerSecondaryLine={(worker) => workerSecondaryLine(worker, translate)}
          onOpenWorker={(worker) => void handleOpenWorker(worker)}
          onOpenCloudSignIn={openCloudSignIn}
          onRefreshWorkers={() => void refreshWorkers()}
          onOpenCloudDashboard={openCloudDashboard}
        />
      </Show>
    </div>
  );

  return (
    <Show when={props.open || isInline()}>
      <div class={isInline() ? "w-full" : modalOverlayClass}>{content}</div>
    </Show>
  );
}

export type { RemoteWorkspaceInput };
