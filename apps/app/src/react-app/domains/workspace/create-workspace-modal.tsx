/** @jsxImportSource react */
import {
  useEffect,
  useMemo,
  useReducer,
  type SetStateAction,
} from "react";
import { ArrowLeft, FolderPlus, Loader2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "../../../i18n";
import { CreateWorkspaceLocalPanel } from "./create-workspace-local-panel";
import {
  createInitialWorkspaceLocalState,
  createWorkspaceLocalReducer,
  shouldTickWorkspaceElapsedClock,
  type CreateWorkspaceLocalState,
} from "./create-workspace-modal-state";
import {
  modalBodyClass,
  pillGhostClass,
  tagClass,
} from "./modal-styles";
import { WorkspaceOptionCard } from "./option-card";
import type {
  CreateWorkspaceModalProps,
  CreateWorkspaceScreen,
} from "./types";

export function CreateWorkspaceModal(props: CreateWorkspaceModalProps) {
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
    projectLabel,
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
  const setProjectLabel = (value: SetStateAction<string>) => setLocal("projectLabel", value);
  const preset = props.defaultPreset ?? "starter";

  const showClose = props.showClose ?? true;
  const submitting = props.submitting ?? false;
  const workerSubmitting = props.workerSubmitting ?? false;
  const progress = props.submittingProgress ?? null;
  const workerDisabled = Boolean(props.workerDisabled);
  const showProjectLabel = props.showProjectLabel ?? true;
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
  const elapsedSeconds = useMemo(() => {
    if (!progress?.startedAt) return 0;
    return Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  }, [now, progress]);

  const headerTitle = (() => {
    switch (screen) {
      case "local":
        return t("dashboard.create_local_workspace_title");
      default:
        return props.title ?? t("dashboard.create_workspace_title");
    }
  })();

  const headerSubtitle = (() => {
    switch (screen) {
      case "local":
        return t("dashboard.create_local_workspace_subtitle");
      default:
        return props.subtitle ?? t("dashboard.create_workspace_subtitle");
    }
  })();

  // Reset state when the modal opens.
  useEffect(() => {
    if (!props.open) return;
    dispatchLocal({ type: "reset" });
  }, [props.open]);

  // The modal remains mounted when closed. Only publish elapsed-time updates
  // while its progress UI is both visible and backed by a real start time.
  useEffect(() => {
    if (!submitting) {
      setShowProgressDetails(false);
    }
    if (!shouldTickWorkspaceElapsedClock({
      open: props.open,
      submitting,
      startedAt: progress?.startedAt,
    })) return;

    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [progress?.startedAt, props.open, submitting]);

  const handlePickFolder = async () => {
    if (pickingFolder) return;
    setPickingFolder(true);
    try {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
      const next = await props.onPickFolder();
      if (next) setSelectedFolder(next);
    } catch {
      // Folder picker cancellation or bridge errors should never leave the
      // modal in a busy state.
    } finally {
      setPickingFolder(false);
    }
  };

  const handleLocalSubmit = async () => {
    props.onConfirm(preset, selectedFolder, {
      projectLabel: projectLabel.trim() || null,
    });
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
              disabled={submitting}
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
            projectLabel={showProjectLabel ? projectLabel : ""}
            onProjectLabelInput={setProjectLabel}
            showProjectLabel={showProjectLabel}
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

      </DialogContent>
    </Dialog>
  );
}
