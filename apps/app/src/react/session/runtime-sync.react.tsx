/** @jsxImportSource react */
import { useEffect } from "react";

import { ensureWorkspaceSessionSync } from "./session-sync";

type ReactSessionRuntimeProps = {
  workspaceId: string;
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

  return null;
}
