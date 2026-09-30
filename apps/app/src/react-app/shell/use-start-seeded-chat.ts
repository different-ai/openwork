import { useCallback } from "react";
import { useNavigate } from "react-router";

import { setPendingChatSeed } from "../domains/session/chat/pending-chat-seed";
import { readActiveWorkspaceId } from "./session-memory";
import { workspaceSessionRoute } from "./workspace-routes";

/**
 * Land on the active workspace's new-task state with `draft` in the composer.
 * Nothing is sent until the person presses send.
 */
export function useStartSeededChat() {
  const navigate = useNavigate();
  return useCallback((draft: string) => {
    setPendingChatSeed(draft);
    const workspaceId = readActiveWorkspaceId();
    navigate(workspaceId ? workspaceSessionRoute(workspaceId) : "/session");
  }, [navigate]);
}
