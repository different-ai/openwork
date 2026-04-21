/** @jsxImportSource react */
import { useEffect } from "react";

import { ensureWorkspaceSessionSync, trackWorkspaceSessionSync } from "./session-sync";

type ReactSessionRuntimeProps = {
  workspaceId: string;
  sessionId: string | null;
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
    return trackWorkspaceSessionSync(
      {
        workspaceId: props.workspaceId,
        baseUrl: props.opencodeBaseUrl,
        openworkToken: props.openworkToken,
      },
      props.sessionId,
    );
  }, [props.workspaceId, props.sessionId, props.opencodeBaseUrl, props.openworkToken]);

  return null;
}
