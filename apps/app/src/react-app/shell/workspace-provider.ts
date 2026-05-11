import * as React from "react";

import type { Client } from "@/app/types";

type WorkspaceContextValue = {
  client: Client | null;
  selectedWorkspaceRoot: string;
};

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

type WorkspaceProviderProps = {
  client: Client | null;
  selectedWorkspaceRoot: string;
  children: React.ReactNode;
};

export function WorkspaceProvider({ client, selectedWorkspaceRoot, children }: WorkspaceProviderProps) {
  const value = React.useMemo(
    () => ({ client, selectedWorkspaceRoot }),
    [client, selectedWorkspaceRoot],
  );

  return React.createElement(WorkspaceContext.Provider, { value }, children);
}

export function useWorkspace() {
  const context = React.use(WorkspaceContext);

  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }

  return context;
}
