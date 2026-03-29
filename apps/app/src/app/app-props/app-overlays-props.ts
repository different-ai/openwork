import type { Accessor } from "solid-js";

import type { AppOverlaysProps } from "../components/app-overlays";

type AppOverlaysPropsBuilderInput = {
  modelPickerOpen: Accessor<AppOverlaysProps["modelPicker"]["open"]>;
  modelPickerOptions: Accessor<AppOverlaysProps["modelPicker"]["options"]>;
  filteredModelOptions: Accessor<AppOverlaysProps["modelPicker"]["filteredOptions"]>;
  modelPickerQuery: Accessor<AppOverlaysProps["modelPicker"]["query"]>;
  setModelPickerQuery: AppOverlaysProps["modelPicker"]["setQuery"];
  modelPickerTarget: Accessor<AppOverlaysProps["modelPicker"]["target"]>;
  modelPickerCurrent: Accessor<AppOverlaysProps["modelPicker"]["current"]>;
  applyModelSelection: AppOverlaysProps["modelPicker"]["onSelect"];
  onModelBehaviorChange: AppOverlaysProps["modelPicker"]["onBehaviorChange"];
  openSettingsFromModelPicker: AppOverlaysProps["modelPicker"]["onOpenSettings"];
  closeModelPicker: AppOverlaysProps["modelPicker"]["onClose"];
  resetModalOpen: Accessor<AppOverlaysProps["reset"]["open"]>;
  resetModalMode: Accessor<AppOverlaysProps["reset"]["mode"]>;
  resetModalText: Accessor<AppOverlaysProps["reset"]["text"]>;
  resetModalBusy: Accessor<AppOverlaysProps["reset"]["busy"]>;
  canReset: Accessor<AppOverlaysProps["reset"]["canReset"]>;
  hasActiveRuns: Accessor<AppOverlaysProps["reset"]["hasActiveRuns"]>;
  language: Accessor<AppOverlaysProps["reset"]["language"]>;
  closeResetModal: AppOverlaysProps["reset"]["onClose"];
  confirmReset: AppOverlaysProps["reset"]["onConfirm"];
  setResetModalText: AppOverlaysProps["reset"]["onTextChange"];
  mcpAuthModalOpen: Accessor<AppOverlaysProps["mcpAuth"]["open"]>;
  mcpAuthClient: Accessor<AppOverlaysProps["mcpAuth"]["client"]>;
  mcpAuthEntry: Accessor<AppOverlaysProps["mcpAuth"]["entry"]>;
  workspaceProjectDir: Accessor<AppOverlaysProps["mcpAuth"]["projectDir"]>;
  mcpAuthNeedsReload: Accessor<AppOverlaysProps["mcpAuth"]["reloadRequired"]>;
  mcpAuthReloadBlocked: Accessor<AppOverlaysProps["mcpAuth"]["reloadBlocked"]>;
  activeReloadBlockingSessions: Accessor<AppOverlaysProps["mcpAuth"]["activeSessions"]>;
  isRemoteWorkspace: Accessor<AppOverlaysProps["mcpAuth"]["isRemoteWorkspace"]>;
  forceStopSession: AppOverlaysProps["mcpAuth"]["onForceStopSession"];
  closeMcpAuthModal: AppOverlaysProps["mcpAuth"]["onClose"];
  completeMcpAuthModal: AppOverlaysProps["mcpAuth"]["onComplete"];
  reloadWorkspaceEngine: AppOverlaysProps["mcpAuth"]["onReloadEngine"];
  sharedBundleImportOpen: Accessor<AppOverlaysProps["sharedBundleImport"]["open"]>;
  sharedBundleImportTitle: Accessor<AppOverlaysProps["sharedBundleImport"]["title"]>;
  sharedBundleImportDescription: Accessor<AppOverlaysProps["sharedBundleImport"]["description"]>;
  sharedBundleImportItems: Accessor<AppOverlaysProps["sharedBundleImport"]["items"]>;
  sharedBundleWorkerOptions: Accessor<AppOverlaysProps["sharedBundleImport"]["workers"]>;
  sharedBundleImportBusy: Accessor<AppOverlaysProps["sharedBundleImport"]["busy"]>;
  sharedBundleImportError: Accessor<AppOverlaysProps["sharedBundleImport"]["error"]>;
  closeSharedBundleImportChoice: AppOverlaysProps["sharedBundleImport"]["onClose"];
  openSharedBundleCreateWorkerFlow: AppOverlaysProps["sharedBundleImport"]["onCreateNewWorker"];
  importSharedBundleIntoExistingWorkspace: AppOverlaysProps["sharedBundleImport"]["onSelectWorker"];
  startWithTemplateOpen: Accessor<AppOverlaysProps["startWithTemplate"]["open"]>;
  sharedTemplateName: Accessor<AppOverlaysProps["startWithTemplate"]["templateName"]>;
  sharedTemplateDescription: Accessor<AppOverlaysProps["startWithTemplate"]["description"]>;
  sharedTemplateStartItems: Accessor<AppOverlaysProps["startWithTemplate"]["items"]>;
  sharedTemplateStartBusy: Accessor<AppOverlaysProps["startWithTemplate"]["busy"]>;
  closeTemplateStart: AppOverlaysProps["startWithTemplate"]["onClose"];
  pickWorkspaceFolder: AppOverlaysProps["startWithTemplate"]["onPickFolder"];
  startWorkspaceFromTemplate: AppOverlaysProps["startWithTemplate"]["onConfirm"];
  createWorkspace: AppOverlaysProps["createWorkspace"];
  sharedSkillDestination: AppOverlaysProps["sharedSkillDestination"];
  createRemoteWorkspace: AppOverlaysProps["createRemoteWorkspace"];
  reloadToast: AppOverlaysProps["reloadToast"];
  statusToast: AppOverlaysProps["statusToast"];
  renameWorkspace: AppOverlaysProps["renameWorkspace"];
  editRemoteWorkspace: AppOverlaysProps["editRemoteWorkspace"];
};

export function createAppOverlaysPropsBuilder(input: AppOverlaysPropsBuilderInput) {
  return () => ({
    modelPicker: {
      open: input.modelPickerOpen(),
      options: input.modelPickerOptions(),
      filteredOptions: input.filteredModelOptions(),
      query: input.modelPickerQuery(),
      setQuery: input.setModelPickerQuery,
      target: input.modelPickerTarget(),
      current: input.modelPickerCurrent(),
      onSelect: input.applyModelSelection,
      onBehaviorChange: input.onModelBehaviorChange,
      onOpenSettings: input.openSettingsFromModelPicker,
      onClose: input.closeModelPicker,
    },
    reset: {
      open: input.resetModalOpen(),
      mode: input.resetModalMode(),
      text: input.resetModalText(),
      busy: input.resetModalBusy(),
      canReset: input.canReset(),
      hasActiveRuns: input.hasActiveRuns(),
      language: input.language(),
      onClose: input.closeResetModal,
      onConfirm: input.confirmReset,
      onTextChange: input.setResetModalText,
    },
    mcpAuth: {
      open: input.mcpAuthModalOpen(),
      client: input.mcpAuthClient(),
      entry: input.mcpAuthEntry(),
      projectDir: input.workspaceProjectDir(),
      language: input.language(),
      reloadRequired: input.mcpAuthNeedsReload(),
      reloadBlocked: input.mcpAuthReloadBlocked(),
      activeSessions: input.activeReloadBlockingSessions(),
      isRemoteWorkspace: input.isRemoteWorkspace(),
      onForceStopSession: input.forceStopSession,
      onClose: input.closeMcpAuthModal,
      onComplete: input.completeMcpAuthModal,
      onReloadEngine: input.reloadWorkspaceEngine,
    },
    sharedBundleImport: {
      open: input.sharedBundleImportOpen(),
      title: input.sharedBundleImportTitle(),
      description: input.sharedBundleImportDescription(),
      items: input.sharedBundleImportItems(),
      workers: input.sharedBundleWorkerOptions(),
      busy: input.sharedBundleImportBusy(),
      error: input.sharedBundleImportError(),
      onClose: input.closeSharedBundleImportChoice,
      onCreateNewWorker: input.openSharedBundleCreateWorkerFlow,
      onSelectWorker: input.importSharedBundleIntoExistingWorkspace,
    },
    startWithTemplate: {
      open: input.startWithTemplateOpen(),
      templateName: input.sharedTemplateName(),
      description: input.sharedTemplateDescription(),
      items: input.sharedTemplateStartItems(),
      busy: input.sharedTemplateStartBusy(),
      onClose: input.closeTemplateStart,
      onPickFolder: input.pickWorkspaceFolder,
      onConfirm: input.startWorkspaceFromTemplate,
    },
    createWorkspace: input.createWorkspace,
    sharedSkillDestination: input.sharedSkillDestination,
    createRemoteWorkspace: input.createRemoteWorkspace,
    reloadToast: input.reloadToast,
    statusToast: input.statusToast,
    renameWorkspace: input.renameWorkspace,
    editRemoteWorkspace: input.editRemoteWorkspace,
  });
}
