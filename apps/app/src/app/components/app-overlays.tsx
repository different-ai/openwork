import CreateRemoteWorkspaceModal from "./create-remote-workspace-modal";
import CreateWorkspaceModal from "./create-workspace-modal";
import McpAuthModal from "./mcp-auth-modal";
import ModelPickerModal from "./model-picker-modal";
import ReloadWorkspaceToast from "./reload-workspace-toast";
import RenameWorkspaceModal from "./rename-workspace-modal";
import ResetModal from "./reset-modal";
import SharedBundleImportModal from "./shared-bundle-import-modal";
import SharedSkillDestinationModal from "./shared-skill-destination-modal";
import StartWithTemplateModal from "./start-with-template-modal";
import StatusToast from "./status-toast";

export type AppOverlaysProps = {
  modelPicker: Parameters<typeof ModelPickerModal>[0];
  reset: Parameters<typeof ResetModal>[0];
  mcpAuth: Parameters<typeof McpAuthModal>[0];
  sharedBundleImport: Parameters<typeof SharedBundleImportModal>[0];
  startWithTemplate: Parameters<typeof StartWithTemplateModal>[0];
  createWorkspace: Parameters<typeof CreateWorkspaceModal>[0];
  sharedSkillDestination: Parameters<typeof SharedSkillDestinationModal>[0];
  createRemoteWorkspace: Parameters<typeof CreateRemoteWorkspaceModal>[0];
  reloadToast: Parameters<typeof ReloadWorkspaceToast>[0];
  statusToast: Parameters<typeof StatusToast>[0];
  renameWorkspace: Parameters<typeof RenameWorkspaceModal>[0];
  editRemoteWorkspace: Parameters<typeof CreateRemoteWorkspaceModal>[0];
};

export default function AppOverlays(props: AppOverlaysProps) {
  return (
    <>
      <ModelPickerModal {...props.modelPicker} />
      <ResetModal {...props.reset} />
      <McpAuthModal {...props.mcpAuth} />
      <SharedBundleImportModal {...props.sharedBundleImport} />
      <StartWithTemplateModal {...props.startWithTemplate} />
      <CreateWorkspaceModal {...props.createWorkspace} />
      <SharedSkillDestinationModal {...props.sharedSkillDestination} />
      <CreateRemoteWorkspaceModal {...props.createRemoteWorkspace} />

      <div class="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(24rem,calc(100vw-1.5rem))] max-w-full flex-col gap-3 sm:right-6 sm:top-6">
        <div class="pointer-events-auto">
          <ReloadWorkspaceToast {...props.reloadToast} />
        </div>

        <div class="pointer-events-auto">
          <StatusToast {...props.statusToast} />
        </div>
      </div>

      <RenameWorkspaceModal {...props.renameWorkspace} />
      <CreateRemoteWorkspaceModal {...props.editRemoteWorkspace} />
    </>
  );
}
