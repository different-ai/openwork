/** @jsxImportSource react */
import { useEffect } from "react";

import { ensureWorkspaceSessionSync, trackWorkspaceSessionsSync } from "./session-sync";

type ReactSessionRuntimeProps = {
  workspaceId: string;
  sessionId: string | null;
  activeSessionIds?: string[];
  opencodeBaseUrl: string;
  openworkToken: string;
};

export function ReactSessionRuntime(props: ReactSessionRuntimeProps) {
  useEffect(() => {
    const input = {
      workspaceId: props.workspaceId,
      baseUrl: props.opencodeBaseUrl,
      openworkToken: props.openworkToken,
    };
    const releaseWorkspace = ensureWorkspaceSessionSync(input);
    const releaseSessions = trackWorkspaceSessionsSync(input, [props.sessionId, ...(props.activeSessionIds ?? [])]);
    return () => {
      releaseSessions();
      releaseWorkspace();
    };
  }, [props.workspaceId, props.sessionId, props.activeSessionIds, props.opencodeBaseUrl, props.openworkToken]);

  return null;
}
