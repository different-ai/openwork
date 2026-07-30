/** @jsxImportSource react */
import { useEffect, useMemo, useRef } from "react";
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
  const callbacksRef = useRef({
    onSessionCreated: props.onSessionCreated,
    onSessionUpdated: props.onSessionUpdated,
    onSessionDeleted: props.onSessionDeleted,
    onSessionStatus: props.onSessionStatus,
  });
  callbacksRef.current = {
    onSessionCreated: props.onSessionCreated,
    onSessionUpdated: props.onSessionUpdated,
    onSessionDeleted: props.onSessionDeleted,
    onSessionStatus: props.onSessionStatus,
  };
  const stableCallbacks = useMemo(() => ({
    onSessionCreated: (session: Session) => callbacksRef.current.onSessionCreated?.(session),
    onSessionUpdated: (update: { sessionId: string; info: Record<string, unknown> }) => callbacksRef.current.onSessionUpdated?.(update),
    onSessionDeleted: (sessionId: string) => callbacksRef.current.onSessionDeleted?.(sessionId),
    onSessionStatus: (update: { sessionId: string; status: SessionStatus }) => callbacksRef.current.onSessionStatus?.(update),
  }), []);
  const activeSessionIdsKey = (props.activeSessionIds ?? []).join(",");

  useEffect(() => {
    const input = {
      workspaceId: props.workspaceId,
      baseUrl: props.opencodeBaseUrl,
      openworkToken: props.openworkToken,
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
