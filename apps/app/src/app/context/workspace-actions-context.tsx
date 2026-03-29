import { createContext, useContext, type Accessor, type ParentProps } from "solid-js";

export type WorkspaceActionsContextValue = {
  openCreateWorkspace: () => void;
  pickFolderWorkspace: () => Promise<boolean>;
  openCreateRemoteWorkspace: () => void;
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  openCloudTemplate: (input: {
    templateId: string;
    name: string;
    templateData: unknown;
    organizationName?: string | null;
  }) => Promise<void> | void;
  importWorkspaceConfig: () => void;
  importingWorkspaceConfig: Accessor<boolean>;
  exportWorkspaceConfig: (workspaceId?: string) => void;
  exportWorkspaceBusy: Accessor<boolean>;
};

const WorkspaceActionsContext = createContext<WorkspaceActionsContextValue | undefined>(undefined);

export function WorkspaceActionsProvider(props: ParentProps<{ value: WorkspaceActionsContextValue }>) {
  return (
    <WorkspaceActionsContext.Provider value={props.value}>
      {props.children}
    </WorkspaceActionsContext.Provider>
  );
}

export function useWorkspaceActions() {
  const context = useContext(WorkspaceActionsContext);
  if (!context) {
    throw new Error("Workspace actions context is missing");
  }
  return context;
}
