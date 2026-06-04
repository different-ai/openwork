/** @jsxImportSource react */
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type SetStateAction,
} from "react";
import { ArrowLeft, FolderPlus, Globe, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "../../../i18n";
import type { WorkspacePreset } from "../../../app/types";
import { CreateWorkspaceLocalPanel } from "./create-workspace-local-panel";
import {
  createInitialWorkspaceLocalState,
  createWorkspaceLocalReducer,
  type CreateWorkspaceLocalState,
} from "./create-workspace-modal-state";
import {
  modalBodyClass,
  pillGhostClass,
  tagClass,
} from "./modal-styles";
import { WorkspaceOptionCard } from "./option-card";
import { RemoteWorkspaceFields } from "./remote-workspace-fields";
import type {
  CreateWorkspaceModalProps,
  CreateWorkspaceScreen,
  RemoteWorkspaceInput,
} from "./types";

export function CreateWorkspaceModal(props: CreateWorkspaceModalProps) {
  const remoteUrlRef = useRef<HTMLInputElement | null>(null);

  const [localState, dispatchLocal] = useReducer(
    createWorkspaceLocalReducer,
    undefined,
    () => createInitialWorkspaceLocalState(),
  );
  const {
    screen,
    selectedFolder,
    pickingFolder,
    showProgressDetails,
    now,
    remoteUrl,
    remoteToken,
    remoteDisplayName,
    remoteTokenVisible,
  } = localState;
  const setLocal = <K extends keyof CreateWorkspaceLocalState>(
    key: K,
    value: SetStateAction<CreateWorkspaceLocalState[K]>,
  ) => dispatchLocal({ type: "set", key, value });
  const setScreen = (value: SetStateAction<CreateWorkspaceScreen>) => setLocal("screen", value);
  const setSelectedFolder = (value: SetStateAction<string | null>) => setLocal("selectedFolder", value);
  const setPickingFolder = (value: SetStateAction<boolean>) => setLocal("pickingFolder", value);
  const setShowProgressDetails = (value: SetStateAction<boolean>) => setLocal("showProgressDetails", value);
  const setNow = (value: SetStateAction<number>) => setLocal("now", value);
  const setRemoteUrl = (value: SetStateAction<string>) => setLocal("remoteUrl", value);
  const setRemoteToken = (value: SetStateAction<string>) => setLocal("remoteToken", value);
  const setRemoteDisplayName = (value: SetStateAction<string>) => setLocal("remoteDisplayName", value);
  const setRemoteTokenVisible = (value: SetStateAction<boolean>) => setLocal("remoteTokenVisible", value);
  const preset = props.defaultPreset ?? "starter";

  const showClose = props.showClose ?? true;
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
  const elapsedSeconds = useMemo(() => {
    if (!progress?.startedAt) return 0;
    return Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  }, [now, progress]);

  const headerTitle = (() => {
    switch (screen) {
      case "local":
        return t("dashboard.create_local_workspace_title");
      case "remote":
        return t("dashboard.create_remote_custom_title");
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
      default:
        return props.subtitle ?? t("dashboard.create_workspace_subtitle");
    }
  })();

  // Reset state when the modal opens.
  useEffect(() => {
    if (!props.open) return;
    dispatchLocal({ type: "reset" });
  }, [props.open]);

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

  const handleLocalSubmit = async () => {
    props.onConfirm(preset, selectedFolder);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        showCloseButton={showClose}
        className="flex max-h-[90vh] min-h-0 w-full max-w-xl flex-col overflow-hidden sm:max-w-xl"
      >
        <DialogHeader className="flex-row">
          {screen !== "chooser" ? (
            <Button
              onClick={() => setScreen("chooser")}
              disabled={submitting || remoteSubmitting}
              variant="ghost"
              size="icon"
              aria-label={t("dashboard.modal_back")}
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <div className="min-w-0 flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>{headerTitle}</DialogTitle>
            </div>
            <DialogDescription>{headerSubtitle}</DialogDescription>
          </div>
        </DialogHeader>

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
            <DialogFooter className="flex-col gap-3">
              {remoteError ? (
                <div className="rounded-[20px] border border-red-7/20 bg-red-1/40 px-4 py-3 text-[13px] text-red-11">
                  {remoteError}
                </div>
              ) : null}
              <div className="flex justify-end gap-3">
                <DialogClose
                  disabled={remoteSubmitting}
                  render={<Button variant="outline" disabled={remoteSubmitting} />}
                >
                  {t("common.cancel")}
                </DialogClose>
                <Button
                  type="button"
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
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : null}

      </DialogContent>
    </Dialog>
  );
}

export type { RemoteWorkspaceInput };
