import * as React from "react";

import type { Client } from "@/app/types";

type WorkspaceContextValue = {
  client: Client | null;
  opencodeBaseUrl: string;
  selectedWorkspaceRoot: string;
  cloudManagedModelIdsByProvider: Map<string, Set<string>>;
};

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

type WorkspaceProviderProps = {
  client: Client | null;
  opencodeBaseUrl?: string;
  selectedWorkspaceRoot: string;
  cloudManagedModelIdsByProvider?: Map<string, Set<string>>;
  children: React.ReactNode;
};

export function WorkspaceProvider({
  client,
  opencodeBaseUrl = "",
  selectedWorkspaceRoot,
  cloudManagedModelIdsByProvider,
  children,
}: WorkspaceProviderProps) {
  const value = React.useMemo(
    () => ({
      client,
      opencodeBaseUrl,
      selectedWorkspaceRoot,
      cloudManagedModelIdsByProvider: cloudManagedModelIdsByProvider ?? new Map<string, Set<string>>(),
    }),
    [client, cloudManagedModelIdsByProvider, opencodeBaseUrl, selectedWorkspaceRoot],
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
