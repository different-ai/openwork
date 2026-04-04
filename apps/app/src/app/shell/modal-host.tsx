import type { Accessor } from "solid-js";
import ModelPickerModal from "../components/model-picker-modal";
import ConfirmModal from "../components/confirm-modal";
import ResetModal from "../components/reset-modal";
import RenameWorkspaceModal from "../components/rename-workspace-modal";
import TopRightNotifications from "./top-right-notifications";
import SkillDestinationModal from "../bundles/skill-destination-modal";
import BundleImportModal from "../bundles/import-modal";
import BundleStartModal from "../bundles/start-modal";
import ConnectionsModals from "../connections/modals";
import { CreateRemoteWorkspaceModal, CreateWorkspaceModal } from "../workspace";
import { currentLocale, t } from "../../i18n";
import { isTauriRuntime } from "../utils";
import { createModelConfigStore } from "../context/model-config";
import { createWorkspaceStore } from "../context/workspace";
import { createBundlesStore } from "../bundles/store";
import type { Client, ReloadTrigger } from "../types";

type ActiveBlockingSession = {
  id: string;
  title: string;
};

type ShellModalHostProps = {
  modelConfig: ReturnType<typeof createModelConfigStore>;
  workspaceStore: ReturnType<typeof createWorkspaceStore>;
  bundlesStore: ReturnType<typeof createBundlesStore>;
  client: Accessor<Client | null>;
  workspaceProjectDir: Accessor<string>;
  resetModalOpen: Accessor<boolean>;
  resetModalMode: Accessor<"onboarding" | "all">;
  resetModalText: Accessor<string>;
  resetModalBusy: Accessor<boolean>;
  setResetModalOpen: (value: boolean) => void;
  confirmReset: () => void;
  setResetModalText: (value: string) => void;
  openSettingsFromModelPicker: () => void;
  anyActiveRuns: Accessor<boolean>;
  activeReloadBlockingSessions: Accessor<ActiveBlockingSession[]>;
  abortSession: (sessionId: string) => Promise<void>;
  reloadWorkspaceEngineAndResume: () => Promise<void>;
  busy: Accessor<boolean>;
  busyLabel: Accessor<string | null>;
  error: Accessor<string | null>;
  reloadOpen: Accessor<boolean>;
  reloadTitle: Accessor<string>;
  reloadDescription: Accessor<string>;
  reloadTrigger: Accessor<ReloadTrigger | undefined>;
  reloadError: Accessor<string | null>;
  reloadBusy: Accessor<boolean>;
  canReloadWorkspace: Accessor<boolean>;
  clearReloadRequired: () => void;
  forceStopActiveSessionsAndReload: () => Promise<void>;
  deepLinkRemoteWorkspaceDefaults: Accessor<{
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  } | null>;
  clearDeepLinkRemoteWorkspaceDefaults: () => void;
};

export default function ModalHost(props: ShellModalHostProps) {
  return (
    <>
      <ModelPickerModal
        open={props.modelConfig.modelPickerOpen()}
        options={props.modelConfig.modelOptions()}
        filteredOptions={props.modelConfig.filteredModelOptions()}
        query={props.modelConfig.modelPickerQuery()}
        setQuery={props.modelConfig.setModelPickerQuery}
        target={props.modelConfig.modelPickerTarget()}
        current={props.modelConfig.modelPickerCurrent()}
        onSelect={props.modelConfig.applyModelSelection}
        onBehaviorChange={props.modelConfig.setModelPickerBehavior}
        onOpenSettings={props.openSettingsFromModelPicker}
        onClose={props.modelConfig.closeModelPicker}
      />

      <ResetModal
        open={props.resetModalOpen()}
        mode={props.resetModalMode()}
        text={props.resetModalText()}
        busy={props.resetModalBusy()}
        canReset={
          !props.resetModalBusy() &&
          !props.anyActiveRuns() &&
          props.resetModalText().trim().toUpperCase() === "RESET"
        }
        hasActiveRuns={props.anyActiveRuns()}
        language={currentLocale()}
        onClose={() => props.setResetModalOpen(false)}
        onConfirm={props.confirmReset}
        onTextChange={props.setResetModalText}
      />

      <ConnectionsModals
        client={props.client()}
        projectDir={props.workspaceProjectDir()}
        language={currentLocale()}
        reloadBlocked={props.activeReloadBlockingSessions().length > 0}
        activeSessions={props.activeReloadBlockingSessions()}
        isRemoteWorkspace={props.workspaceStore.selectedWorkspaceDisplay().workspaceType === "remote"}
        onForceStopSession={(sessionID) => props.abortSession(sessionID)}
        onReloadEngine={() => props.reloadWorkspaceEngineAndResume()}
      />

      <BundleImportModal
        open={Boolean(props.bundlesStore.bundleImportChoice())}
        title={props.bundlesStore.bundleImportSummary()?.title ?? t("app.import_shared_bundle")}
        description={props.bundlesStore.bundleImportSummary()?.description ?? t("app.import_bundle_desc")}
        items={props.bundlesStore.bundleImportSummary()?.items ?? []}
        workers={props.bundlesStore.bundleWorkerOptions()}
        busy={props.bundlesStore.bundleImportBusy()}
        error={props.bundlesStore.bundleImportError()}
        onClose={props.bundlesStore.closeBundleImportChoice}
        onCreateNewWorker={() => {
          void props.bundlesStore.openCreateWorkspaceFromChoice();
        }}
        onSelectWorker={(workspaceId) => {
          void props.bundlesStore.importBundleIntoExistingWorkspace(workspaceId);
        }}
      />

      <ConfirmModal
        open={Boolean(props.bundlesStore.untrustedBundleWarning())}
        title="Import from an untrusted bundle link?"
        message={(() => {
          const warning = props.bundlesStore.untrustedBundleWarning();
          const actualOrigin = warning?.actualOrigin?.trim() || "an unknown origin";
          const configuredOrigin =
            warning?.configuredOrigin?.trim() || "the configured OpenWork share service";
          return `This link points to ${actualOrigin}, but OpenWork only auto-imports bundles from ${configuredOrigin}. Untrusted bundles can contain malicious instructions or settings. Only continue if you trust the sender and expect this import.`;
        })()}
        confirmLabel="Import anyway"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => {
          void props.bundlesStore.confirmUntrustedBundleWarning();
        }}
        onCancel={props.bundlesStore.dismissUntrustedBundleWarning}
      />

      <BundleStartModal
        open={Boolean(props.bundlesStore.bundleStartRequest())}
        templateName={props.bundlesStore.bundleStartRequest()?.bundle.name?.trim() || "this template"}
        description={props.bundlesStore.bundleStartRequest()?.bundle.description ?? ""}
        items={props.bundlesStore.bundleStartItems()}
        busy={props.bundlesStore.bundleStartBusy()}
        onClose={() => {
          props.bundlesStore.clearBundleStartRequest();
        }}
        onPickFolder={props.workspaceStore.pickWorkspaceFolder}
        onConfirm={(folder) => {
          void props.bundlesStore.startWorkspaceFromBundle(folder);
        }}
      />

      <CreateWorkspaceModal
        open={props.workspaceStore.createWorkspaceOpen()}
        onClose={() => {
          props.workspaceStore.setCreateWorkspaceOpen(false);
          props.workspaceStore.clearSandboxCreateProgress?.();
          props.bundlesStore.clearCreateWorkspaceRequest();
        }}
        onPickFolder={props.workspaceStore.pickWorkspaceFolder}
        onImportConfig={isTauriRuntime() ? props.workspaceStore.importWorkspaceConfig : undefined}
        importingConfig={props.workspaceStore.importingWorkspaceConfig()}
        defaultPreset={props.bundlesStore.createWorkspaceDefaultPreset()}
        onConfirmRemote={(input) => props.workspaceStore.createRemoteWorkspaceFlow(input)}
        onConfirmTemplate={(template, preset, folder) =>
          props.bundlesStore.startWorkspaceFromTeamTemplate({
            name: template.name,
            templateData: template.templateData,
            folder,
            preset,
          })
        }
        onConfirm={props.bundlesStore.handleCreateWorkspaceConfirm}
        onConfirmWorker={
          isTauriRuntime() ? props.bundlesStore.handleCreateSandboxConfirm : undefined
        }
        workerDisabled={(() => {
          if (!isTauriRuntime()) return true;
          if (props.workspaceStore.sandboxDoctorBusy?.()) return true;
          const doctor = props.workspaceStore.sandboxDoctorResult?.();
          if (!doctor) return false;
          return !doctor?.ready;
        })()}
        workerDisabledReason={(() => {
          if (!isTauriRuntime()) return t("app.error.tauri_required", currentLocale());
          if (props.workspaceStore.sandboxDoctorBusy?.()) {
            return t("dashboard.sandbox_checking_docker", currentLocale());
          }
          const doctor = props.workspaceStore.sandboxDoctorResult?.();
          if (!doctor || doctor.ready) return null;
          const message = doctor?.error?.trim();
          return message || t("dashboard.sandbox_get_ready_desc", currentLocale());
        })()}
        workerCtaLabel={t("dashboard.sandbox_get_ready_action", currentLocale())}
        workerCtaDescription={t("dashboard.sandbox_get_ready_desc", currentLocale())}
        onWorkerCta={async () => {
          const url = "https://www.docker.com/products/docker-desktop/";
          if (isTauriRuntime()) {
            const { openUrl } = await import("@tauri-apps/plugin-opener");
            await openUrl(url);
          } else {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        }}
        workerRetryLabel={t("common.retry", currentLocale())}
        workerDebugLines={(() => {
          const doctor = props.workspaceStore.sandboxDoctorResult?.();
          const lines: string[] = [];
          if (!doctor?.debug) return lines;
          const selected = doctor.debug.selectedBin?.trim();
          if (selected) lines.push(`selected: ${selected}`);
          if (doctor.debug.candidates?.length) {
            lines.push(`candidates: ${doctor.debug.candidates.join(", ")}`);
          }
          if (doctor.debug.versionCommand) {
            const cmd = doctor.debug.versionCommand;
            lines.push(`docker --version exit=${cmd.status}`);
            if (cmd.stderr?.trim()) lines.push(`docker --version stderr: ${cmd.stderr.trim()}`);
          }
          if (doctor.debug.infoCommand) {
            const cmd = doctor.debug.infoCommand;
            lines.push(`docker info exit=${cmd.status}`);
            if (cmd.stderr?.trim()) lines.push(`docker info stderr: ${cmd.stderr.trim()}`);
          }
          return lines;
        })()}
        onWorkerRetry={() => {
          void props.workspaceStore.refreshSandboxDoctor?.();
        }}
        workerSubmitting={props.workspaceStore.sandboxPreflightBusy?.() ?? false}
        localDisabled={!isTauriRuntime()}
        localDisabledReason={!isTauriRuntime() ? t("app.local_disabled_reason") : null}
        remoteSubmitting={props.busy() && props.busyLabel() === "status.connecting"}
        remoteError={props.busyLabel() === "status.connecting" ? props.error() : null}
        submitting={(() => {
          const phase = props.workspaceStore.sandboxCreatePhase?.() ?? "idle";
          if (phase === "provisioning" || phase === "finalizing") return true;
          return props.busy() && props.busyLabel() === "status.creating_workspace";
        })()}
        submittingProgress={props.workspaceStore.sandboxCreateProgress?.() ?? null}
      />

      <SkillDestinationModal
        open={
          Boolean(props.bundlesStore.skillDestinationRequest()) &&
          !props.workspaceStore.createWorkspaceOpen() &&
          !props.workspaceStore.createRemoteWorkspaceOpen()
        }
        skill={(() => {
          const request = props.bundlesStore.skillDestinationRequest();
          if (!request) return null;
          return {
            name: request.bundle.name,
            description: request.bundle.description ?? null,
            trigger: request.bundle.trigger ?? null,
          };
        })()}
        workspaces={props.bundlesStore.skillDestinationWorkspaces()}
        selectedWorkspaceId={props.workspaceStore.selectedWorkspaceId()}
        busyWorkspaceId={props.bundlesStore.skillDestinationBusyId()}
        onClose={() => {
          props.bundlesStore.clearSkillDestinationRequest();
        }}
        onSubmitWorkspace={props.bundlesStore.importSkillIntoWorkspace}
        onCreateWorker={
          isTauriRuntime()
            ? props.bundlesStore.openCreateWorkspaceFromSkillDestination
            : undefined
        }
        onConnectRemote={() => {
          props.bundlesStore.openRemoteConnectFromSkillDestination();
        }}
      />

      <CreateRemoteWorkspaceModal
        open={props.workspaceStore.createRemoteWorkspaceOpen()}
        onClose={() => {
          props.workspaceStore.setCreateRemoteWorkspaceOpen(false);
          props.clearDeepLinkRemoteWorkspaceDefaults();
        }}
        onConfirm={(input) => props.workspaceStore.createRemoteWorkspaceFlow(input)}
        initialValues={props.deepLinkRemoteWorkspaceDefaults() ?? undefined}
        submitting={
          props.busy() &&
          (props.busyLabel() === "status.creating_workspace" ||
            props.busyLabel() === "status.connecting")
        }
      />

      <TopRightNotifications
        reloadOpen={props.reloadOpen()}
        reloadTitle={props.reloadTitle()}
        reloadDescription={props.reloadDescription()}
        reloadTrigger={props.reloadTrigger()}
        reloadError={props.reloadError()}
        reloadLabel={
          props.activeReloadBlockingSessions().length > 0
            ? t("app.reload_stop_tasks")
            : t("app.reload_now")
        }
        dismissLabel={t("app.reload_later")}
        reloadBusy={props.reloadBusy()}
        canReload={props.canReloadWorkspace()}
        hasActiveRuns={props.activeReloadBlockingSessions().length > 0}
        onReload={() => {
          void (props.activeReloadBlockingSessions().length > 0
            ? props.forceStopActiveSessionsAndReload()
            : props.reloadWorkspaceEngineAndResume());
        }}
        onDismissReload={props.clearReloadRequired}
      />

      <RenameWorkspaceModal
        open={props.workspaceStore.renameWorkspaceOpen()}
        title={props.workspaceStore.renameWorkspaceName()}
        busy={props.workspaceStore.renameWorkspaceBusy()}
        canSave={
          props.workspaceStore.renameWorkspaceName().trim().length > 0 &&
          !props.workspaceStore.renameWorkspaceBusy()
        }
        onClose={props.workspaceStore.closeRenameWorkspace}
        onSave={props.workspaceStore.saveRenameWorkspace}
        onTitleChange={props.workspaceStore.setRenameWorkspaceName}
      />

      <CreateRemoteWorkspaceModal
        open={props.workspaceStore.editRemoteWorkspaceOpen()}
        onClose={props.workspaceStore.closeWorkspaceConnectionSettings}
        onConfirm={(input) => {
          void props.workspaceStore.saveWorkspaceConnectionSettings(input);
        }}
        initialValues={props.workspaceStore.editRemoteWorkspaceDefaults() ?? undefined}
        submitting={props.busy() && props.busyLabel() === "status.connecting"}
        error={props.workspaceStore.editRemoteWorkspaceError()}
        title={t("dashboard.edit_remote_workspace_title", currentLocale())}
        subtitle={t("dashboard.edit_remote_workspace_subtitle", currentLocale())}
        confirmLabel={t("dashboard.edit_remote_workspace_confirm", currentLocale())}
      />
    </>
  );
}
