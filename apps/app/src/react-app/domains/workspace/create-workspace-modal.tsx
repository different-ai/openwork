/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowLeft, Cloud, FolderPlus, Globe, Loader2, X } from "lucide-react";

import { t } from "../../../i18n";
import {
  buildDenAuthUrl,
  createDenClient,
  type DenOrgSummary,
  type DenWorkerSummary,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
} from "../../../app/lib/den";
import type { WorkspacePreset } from "../../../app/types";
import { usePlatform } from "../../kernel/platform";
import { CreateWorkspaceLocalPanel } from "./create-workspace-local-panel";
import { CreateWorkspaceSharedPanel } from "./create-workspace-shared-panel";
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
import { WorkspaceOptionCard } from "./option-card";
import { RemoteWorkspaceFields } from "./remote-workspace-fields";
import type {
  CreateWorkspaceModalProps,
  CreateWorkspaceScreen,
  RemoteWorkspaceInput,
} from "./types";

function workerStatusMeta(status: string) {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "healthy":
      return {
        label: t("dashboard.worker_status_ready"),
        tone: "ready" as const,
        canOpen: true,
      };
    case "provisioning":
    case "starting":
      return {
        label: t("dashboard.worker_status_starting"),
        tone: "warning" as const,
        canOpen: false,
      };
    case "failed":
    case "error":
      return {
        label: t("dashboard.worker_status_attention"),
        tone: "error" as const,
        canOpen: false,
      };
    case "stopped":
      return {
        label: t("dashboard.worker_status_stopped"),
        tone: "neutral" as const,
        canOpen: false,
      };
    default:
      return {
        label: normalized
          ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`
          : t("common.unknown"),
        tone: "neutral" as const,
        canOpen: normalized === "ready",
      };
  }
}

function workerSecondaryLine(worker: DenWorkerSummary) {
  const parts = [worker.provider?.trim() || t("dashboard.cloud_worker")];
  if (worker.instanceUrl?.trim()) parts.push(worker.instanceUrl.trim());
  return parts.join(" · ");
}

export function CreateWorkspaceModal(props: CreateWorkspaceModalProps) {
  const remoteUrlRef = useRef<HTMLInputElement | null>(null);
  const platform = usePlatform();

  const [screen, setScreen] = useState<CreateWorkspaceScreen>("chooser");
  const preset = props.defaultPreset ?? "starter";
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [showProgressDetails, setShowProgressDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [cloudSettings, setCloudSettings] = useState(() => readDenSettings());
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteDisplayName, setRemoteDisplayName] = useState("");
  const [remoteTokenVisible, setRemoteTokenVisible] = useState(false);
  const [orgs, setOrgs] = useState<DenOrgSummary[]>([]);
  const [activeOrgId, setActiveOrgId] = useState("");
  const [orgsBusy, setOrgsBusy] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<DenWorkerSummary[]>([]);
  const [workersBusy, setWorkersBusy] = useState(false);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [openingWorkerId, setOpeningWorkerId] = useState<string | null>(null);
  const [workerSearch, setWorkerSearch] = useState("");

  const showClose = props.showClose ?? true;
  const isInline = props.inline ?? false;
  const submitting = props.submitting ?? false;
  const remoteSubmitting = props.remoteSubmitting ?? false;
  const workerSubmitting = props.workerSubmitting ?? false;
  const progress = props.submittingProgress ?? null;
  const workerDisabled = Boolean(props.workerDisabled);
  const workerDisabledReason = (props.workerDisabledReason ?? "").trim();
  const workerDebugLines = useMemo(
    () => (props.workerDebugLines ?? []).flatMap((line) => {
      const trimmed = line.trim();
      return trimmed ? [trimmed] : [];
    }),
    [props.workerDebugLines],
  );
  const hasSelectedFolder = Boolean(selectedFolder?.trim());
  const localError = (props.localError ?? "").trim() || null;
  const remoteError = (props.remoteError ?? "").trim() || null;
  const isSignedIn = Boolean(cloudSettings.authToken?.trim());
  const denClient = useMemo(
    () =>
      createDenClient({
        baseUrl: cloudSettings.baseUrl,
        token: cloudSettings.authToken ?? "",
      }),
    [cloudSettings.authToken, cloudSettings.baseUrl],
  );
  const elapsedSeconds = useMemo(() => {
    if (!progress?.startedAt) return 0;
    return Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  }, [now, progress]);
  const filteredWorkers = useMemo(() => {
    const query = workerSearch.trim().toLowerCase();
    if (!query) return workers;
    return workers.filter((worker) => {
      const haystack = [
        worker.workerName,
        worker.provider,
        worker.instanceUrl,
        worker.status,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [workerSearch, workers]);

  const modalWidthClass =
    screen === "shared" ? "max-w-[640px]" : "max-w-[560px]";

  const headerTitle = (() => {
    switch (screen) {
      case "local":
        return t("dashboard.create_local_workspace_title");
      case "remote":
        return t("dashboard.create_remote_custom_title");
      case "shared":
        return t("dashboard.create_shared_title");
      default:
        return props.title ?? t("dashboard.create_workspace_title");
    }
  })();

  const headerSubtitle = (() => {
    switch (screen) {
      case "local":
        return t("dashboard.create_local_workspace_subtitle");
      case "remote":
        return t("dashboard.create_remote_custom_subtitle");
      case "shared":
        return isSignedIn
          ? t("dashboard.create_shared_subtitle_signed_in")
          : t("dashboard.create_shared_subtitle_signed_out");
      default:
        return props.subtitle ?? t("dashboard.create_workspace_subtitle");
    }
  })();

  // Reset state when the modal opens.
  useEffect(() => {
    if (!props.open) return;
    const settings = readDenSettings();
    setScreen("chooser");
    setCloudSettings(settings);
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
  }, [props.open]);

  // React to Den session changes.
  useEffect(() => {
    if (!props.open && !isInline) return;
    const handler = () => {
      const settings = readDenSettings();
      setCloudSettings(settings);
      setActiveOrgId(settings.activeOrgId?.trim() ?? "");
    };
    window.addEventListener(
      "openwork-den-session-updated",
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        "openwork-den-session-updated",
        handler as EventListener,
      );
  }, [isInline, props.open]);

  // Tick the "elapsed" clock while submitting.
  useEffect(() => {
    if (!submitting) {
      setShowProgressDetails(false);
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [submitting]);

  // Focus the URL field when the remote screen opens.
  useEffect(() => {
    if (!props.open) return;
    if (screen !== "remote") return;
    const frame = requestAnimationFrame(() => remoteUrlRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open, screen]);

  const applyActiveOrg = useCallback(
    (nextOrg: DenOrgSummary | null) => {
      setActiveOrgId(nextOrg?.id ?? "");
      const nextSettings = {
        ...cloudSettings,
        activeOrgId: nextOrg?.id ?? null,
        activeOrgSlug: nextOrg?.slug ?? null,
        activeOrgName: nextOrg?.name ?? null,
      };
      writeDenSettings(nextSettings);
      setCloudSettings(nextSettings);
    },
    [cloudSettings],
  );

  const refreshOrgs = useCallback(async () => {
    if (!isSignedIn) return;
    setOrgsBusy(true);
    setOrgsError(null);
    try {
      const { orgs: nextOrgs, defaultOrgId } = await denClient.listOrgs();
      setOrgs(nextOrgs);
      const preferred = cloudSettings.activeOrgId?.trim();
      const nextActive =
        nextOrgs.find((org) => org.id === preferred) ??
        nextOrgs.find((org) => org.id === defaultOrgId) ??
        nextOrgs[0] ??
        null;
      applyActiveOrg(nextActive);
    } catch (error) {
      setOrgsError(
        error instanceof Error
          ? error.message
          : t("dashboard.error_load_orgs"),
      );
    } finally {
      setOrgsBusy(false);
    }
  }, [
    applyActiveOrg,
    cloudSettings.activeOrgId,
    denClient,
    isSignedIn,
  ]);

  const refreshWorkers = useCallback(
    async (orgId = activeOrgId.trim()) => {
      if (!orgId || !isSignedIn) return;
      setWorkersBusy(true);
      setWorkersError(null);
      try {
        const nextWorkers = await denClient.listWorkers(orgId);
        setWorkers(nextWorkers);
      } catch (error) {
        setWorkersError(
          error instanceof Error
            ? error.message
            : t("dashboard.error_load_shared_workspaces"),
        );
      } finally {
        setWorkersBusy(false);
      }
    },
    [activeOrgId, denClient, isSignedIn],
  );

  // Load orgs/workers when the shared tab is active and signed in.
  useEffect(() => {
    if (!props.open || screen !== "shared" || !isSignedIn) return;
    void refreshOrgs();
  }, [isSignedIn, props.open, refreshOrgs, screen]);

  useEffect(() => {
    if (!props.open || screen !== "shared" || !isSignedIn) return;
    const orgId = activeOrgId.trim();
    if (!orgId) return;
    void refreshWorkers(orgId);
  }, [activeOrgId, isSignedIn, props.open, refreshWorkers, screen]);

  const handlePickFolder = async () => {
    if (pickingFolder) return;
    setPickingFolder(true);
    try {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
      const next = await props.onPickFolder();
      if (next) setSelectedFolder(next);
    } finally {
      setPickingFolder(false);
    }
  };

  const openCloudSignIn = () => {
    platform.openLink(buildDenAuthUrl(cloudSettings.baseUrl, "sign-in"));
  };

  const openCloudDashboard = () => {
    platform.openLink(resolveDenBaseUrls(cloudSettings.baseUrl).baseUrl);
  };

  const handleRemoteSubmit = async () => {
    if (!props.onConfirmRemote) return;
    await Promise.resolve(
      props.onConfirmRemote({
        openworkHostUrl: remoteUrl.trim(),
        openworkToken: remoteToken.trim() || null,
        directory: null,
        displayName: remoteDisplayName.trim() || null,
        closeModal: true,
      }),
    );
  };

  const handleOpenWorker = async (worker: DenWorkerSummary) => {
    if (!props.onConfirmRemote) return;
    const orgId = activeOrgId.trim();
    if (!orgId) {
      setWorkersError(t("dashboard.error_choose_org"));
      return;
    }
    setOpeningWorkerId(worker.workerId);
    setWorkersError(null);
    try {
      const tokens = await denClient.getWorkerTokens(worker.workerId, orgId);
      const openworkUrl = tokens.openworkUrl?.trim() ?? "";
      const accessToken =
        tokens.ownerToken?.trim() || tokens.clientToken?.trim() || "";
      if (!openworkUrl || !accessToken) {
        throw new Error(t("dashboard.error_workspace_not_ready"));
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
        throw new Error(
          t("dashboard.error_connect_worker", {
            name: worker.workerName,
          }),
        );
      }
    } catch (error) {
      setWorkersError(
        error instanceof Error
          ? error.message
          : t("dashboard.error_connect_worker", {
              name: worker.workerName,
            }),
      );
    } finally {
      setOpeningWorkerId(null);
    }
  };

  const handleLocalSubmit = async () => {
    props.onConfirm(preset, selectedFolder);
  };

  if (!props.open && !isInline) {
    return null;
  }

  const content = (
    <div className={`${modalShellClass} ${modalWidthClass}`}>
      <div className={modalHeaderClass}>
        <div className="flex min-w-0 items-start gap-3">
          {screen !== "chooser" ? (
            <button
              type="button"
              onClick={() => setScreen("chooser")}
              disabled={submitting || remoteSubmitting}
              className={modalHeaderButtonClass}
              aria-label={t("dashboard.modal_back")}
            >
              <ArrowLeft size={18} />
            </button>
          ) : null}
          <div className="min-w-0">
            <h3 className={modalTitleClass}>{headerTitle}</h3>
            <p className={modalSubtitleClass}>{headerSubtitle}</p>
          </div>
        </div>
        {showClose ? (
          <button
            type="button"
            onClick={props.onClose}
            disabled={submitting || remoteSubmitting}
            className={modalHeaderButtonClass}
            aria-label={t("dashboard.modal_close")}
          >
            <X size={18} />
          </button>
        ) : null}
      </div>

      {screen === "chooser" ? (
        <div className={modalBodyClass}>
          <div className="space-y-3">
            <WorkspaceOptionCard
              title={t("dashboard.create_local_workspace_title")}
              description={
                props.localDisabled
                  ? props.localDisabledReason?.trim() ||
                    t("dashboard.chooser_local_desc")
                  : t("dashboard.chooser_local_desc")
              }
              icon={FolderPlus}
              onClick={() => setScreen("local")}
              disabled={props.localDisabled}
              endAdornment={
                props.localDisabled ? (
                  <span className={tagClass}>
                    {t("dashboard.desktop_badge")}
                  </span>
                ) : undefined
              }
            />
            <WorkspaceOptionCard
              title={t("dashboard.create_remote_custom_title")}
              description={t("dashboard.chooser_remote_desc")}
              icon={Globe}
              onClick={() => setScreen("remote")}
            />
            <WorkspaceOptionCard
              title={t("dashboard.create_shared_title")}
              description={t("dashboard.chooser_shared_desc")}
              icon={Cloud}
              onClick={() => setScreen("shared")}
            />

            {props.onImportConfig ? (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => props.onImportConfig?.()}
                  disabled={props.importingConfig}
                  className={pillGhostClass}
                >
                  {props.importingConfig ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 size={14} className="animate-spin" />
                      {t("dashboard.importing")}
                    </span>
                  ) : (
                    t("dashboard.import_config")
                  )}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {screen === "local" ? (
        <CreateWorkspaceLocalPanel
          selectedFolder={selectedFolder}
          hasSelectedFolder={hasSelectedFolder}
          pickingFolder={pickingFolder}
          onPickFolder={() => void handlePickFolder()}
          submitting={submitting}
          localError={localError}
          onClose={props.onClose}
          onSubmit={() => void handleLocalSubmit()}
          confirmLabel={props.confirmLabel}
          workerLabel={props.workerLabel}
          onConfirmWorker={props.onConfirmWorker}
          preset={preset}
          workerSubmitting={workerSubmitting}
          workerDisabled={workerDisabled}
          workerDisabledReason={workerDisabledReason}
          workerCtaLabel={props.workerCtaLabel}
          workerCtaDescription={props.workerCtaDescription}
          onWorkerCta={props.onWorkerCta}
          workerRetryLabel={props.workerRetryLabel}
          onWorkerRetry={props.onWorkerRetry}
          workerDebugLines={workerDebugLines}
          progress={progress}
          elapsedSeconds={elapsedSeconds}
          showProgressDetails={showProgressDetails}
          onToggleProgressDetails={() =>
            setShowProgressDetails((prev) => !prev)
          }
        />
      ) : null}

      {screen === "remote" ? (
        <>
          <div className={modalBodyClass}>
            <RemoteWorkspaceFields
              hostUrl={remoteUrl}
              onHostUrlInput={setRemoteUrl}
              token={remoteToken}
              tokenVisible={remoteTokenVisible}
              onTokenInput={setRemoteToken}
              onToggleTokenVisible={() =>
                setRemoteTokenVisible((prev) => !prev)
              }
              displayName={remoteDisplayName}
              onDisplayNameInput={setRemoteDisplayName}
              submitting={remoteSubmitting}
              hostInputRef={remoteUrlRef}
              title={t("dashboard.remote_server_details_title")}
              description={t("dashboard.remote_server_details_hint")}
            />
          </div>
          <div className="space-y-3 border-t border-dls-border px-6 py-5">
            {remoteError ? (
              <div className="rounded-[20px] border border-red-7/20 bg-red-1/40 px-4 py-3 text-[13px] text-red-11">
                {remoteError}
              </div>
            ) : null}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                className={pillGhostClass}
                onClick={props.onClose}
                disabled={remoteSubmitting}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={pillPrimaryClass}
                disabled={!remoteUrl.trim() || remoteSubmitting}
                onClick={() => void handleRemoteSubmit()}
              >
                {remoteSubmitting ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" />
                    {t("dashboard.connecting")}
                  </span>
                ) : (
                  t("dashboard.connect_remote_button")
                )}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {screen === "shared" ? (
        <CreateWorkspaceSharedPanel
          signedIn={isSignedIn}
          orgs={orgs}
          activeOrgId={activeOrgId}
          onActiveOrgChange={(orgId) => {
            const nextOrg = orgs.find((org) => org.id === orgId) ?? null;
            applyActiveOrg(nextOrg);
          }}
          orgsBusy={orgsBusy}
          orgsError={orgsError}
          workers={workers}
          workersBusy={workersBusy}
          workersError={workersError}
          workerSearch={workerSearch}
          onWorkerSearchInput={setWorkerSearch}
          filteredWorkers={filteredWorkers}
          openingWorkerId={openingWorkerId}
          workerStatusMeta={(status) => workerStatusMeta(status)}
          workerSecondaryLine={(worker) => workerSecondaryLine(worker)}
          onOpenWorker={(worker) => void handleOpenWorker(worker)}
          onOpenCloudSignIn={openCloudSignIn}
          onRefreshWorkers={() => void refreshWorkers()}
          onOpenCloudDashboard={openCloudDashboard}
        />
      ) : null}
    </div>
  );

  return (
    <div className={isInline ? "w-full" : modalOverlayClass}>{content}</div>
  );
}

export type { RemoteWorkspaceInput };
