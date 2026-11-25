import { describe, expect, test } from "bun:test";
import {
  canNavigateSelectedConversationHistory,
  createConversationTabHistory,
  navigateConversationTabHistory,
  syncConversationTabHistory,
} from "../src/react-app/domains/session/chat/conversation-tab-history";
import { remoteSessionRouteId } from "../src/lib/remote-session-route";

describe("conversation history with a task on another computer", () => {
  const workspaceId = "ws_1";
  const remote = remoteSessionRouteId("command:rsc_1");

  test("the remote task's route is an entry, so Back from it returns to the chat and Forward reopens it", () => {
    let history = createConversationTabHistory(workspaceId, "ses_parent");
    history = syncConversationTabHistory(history, workspaceId, remote);
    expect(canNavigateSelectedConversationHistory(history, workspaceId, remote, "back")).toBe(true);

    const back = navigateConversationTabHistory(history, "back");
    expect(back.entry?.sessionId).toBe("ses_parent");
    expect(canNavigateSelectedConversationHistory(back.history, workspaceId, "ses_parent", "forward")).toBe(true);

    const forward = navigateConversationTabHistory(back.history, "forward");
    expect(forward.entry?.sessionId).toBe(remote);
  });

  test("a route with no conversation at all still starts a fresh history", () => {
    const history = syncConversationTabHistory(createConversationTabHistory(workspaceId, "ses_parent"), workspaceId, null);
    expect(history.entries).toEqual([]);
  });
});
