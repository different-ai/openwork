import * as React from "react";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";

import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";

export type OpenTargetOptions = {
  external?: boolean;
  reveal?: boolean;
};

type OpenTargetHandler = (target: OpenTarget, options?: OpenTargetOptions) => void;

type OpenTargetContextValue = {
  client?: OpenworkServerClient;
  workspaceId?: string;
  workspaceRoot?: string;
  /** The conversation being shown; lets file reads follow it into a worktree. */
  sessionId?: string;
  isLocalWorkspace?: boolean;
  openTargets: OpenTarget[];
  onOpenTarget: OpenTargetHandler | undefined;
};

type OpenTargetProviderProps = {
  children: React.ReactNode;
  client?: OpenworkServerClient;
  workspaceId?: string;
  workspaceRoot?: string;
  sessionId?: string;
  isLocalWorkspace?: boolean;
  openTargets?: OpenTarget[] | undefined;
  onOpenTarget?: OpenTargetHandler | undefined;
};

const EMPTY_OPEN_TARGETS: OpenTarget[] = [];

const OpenTargetContext = React.createContext<OpenTargetContextValue>({
  openTargets: EMPTY_OPEN_TARGETS,
  onOpenTarget: undefined,
});

export function OpenTargetProvider({
  children,
  client,
  workspaceId,
  workspaceRoot,
  sessionId,
  isLocalWorkspace = false,
  openTargets = EMPTY_OPEN_TARGETS,
  onOpenTarget,
}: OpenTargetProviderProps) {
  const value = React.useMemo(
    () => ({
      client,
      workspaceId,
      workspaceRoot,
      sessionId,
      isLocalWorkspace,
      openTargets,
      onOpenTarget,
    }),
    [client, workspaceId, workspaceRoot, sessionId, isLocalWorkspace, openTargets, onOpenTarget],
  );

  return React.createElement(OpenTargetContext.Provider, { value }, children);
}

export function useOpenTargets() {
  return React.useContext(OpenTargetContext);
}
