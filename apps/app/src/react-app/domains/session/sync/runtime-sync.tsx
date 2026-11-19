/** @jsxImportSource react */
import { useEffect, useMemo } from "react";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client";

import { ensureWorkspaceSessionSync, trackWorkspaceSessionsSync } from "./session-sync";

type ReactSessionRuntimeProps = {
  workspaceId: string;
  sessionId: string | null;
  activeSessionIds?: string[];
  opencodeBaseUrl: string;
  openworkToken: string;
  onSessionCreated?: (session: Session) => void;
  onSessionUpdated?: (update: { sessionId: string; info: Record<string, unknown> }) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onSessionStatus?: (update: { sessionId: string; status: SessionStatus }) => void;
};

export function ReactSessionRuntime(props: ReactSessionRuntimeProps) {
  const stableCallbacks = useMemo(() => ({
    onSessionCreated: props.onSessionCreated,
    onSessionUpdated: props.onSessionUpdated,
    onSessionDeleted: props.onSessionDeleted,
    onSessionStatus: props.onSessionStatus,
  }), [props.onSessionCreated, props.onSessionUpdated, props.onSessionDeleted, props.onSessionStatus]);
  const activeSessionIdsKey = (props.activeSessionIds ?? []).join(",");

  useEffect(() => {
    const input = {
      workspaceId: props.workspaceId,
      baseUrl: props.opencodeBaseUrl,
      openworkToken: props.openworkToken,
      visibleSessionId: props.sessionId,
      ...stableCallbacks,
    };
    const releaseWorkspace = ensureWorkspaceSessionSync(input);
    const releaseSessions = trackWorkspaceSessionsSync(input, [props.sessionId, ...(props.activeSessionIds ?? [])]);
    return () => {
      releaseSessions();
      releaseWorkspace();
    };
  }, [props.workspaceId, props.sessionId, activeSessionIdsKey, props.opencodeBaseUrl, props.openworkToken, stableCallbacks]);

  return null;
}
