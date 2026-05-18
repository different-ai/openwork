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
    return ensureWorkspaceSessionSync({
      workspaceId: props.workspaceId,
      baseUrl: props.opencodeBaseUrl,
      openworkToken: props.openworkToken,
    });
  }, [props.workspaceId, props.opencodeBaseUrl, props.openworkToken]);

  useEffect(() => {
    return trackWorkspaceSessionsSync(
      {
        workspaceId: props.workspaceId,
        baseUrl: props.opencodeBaseUrl,
        openworkToken: props.openworkToken,
      },
      [props.sessionId, ...(props.activeSessionIds ?? [])],
    );
  }, [props.workspaceId, props.sessionId, props.activeSessionIds, props.opencodeBaseUrl, props.openworkToken]);

  return null;
}
