import { expect, test } from "bun:test";
import {
  beginPendingConversation,
  createPendingConversation,
  retryPendingConversation,
  usePendingConversationStore,
  withPendingSessionPublication,
} from "@/react-app/domains/session/chat/pending-conversation-store";

test("a sandbox admission refusal keeps first-message text editable without publishing a failed session", async () => {
  const submitted = { draft: "Original draft", attachments: [], mentions: {}, pasteParts: [], revertMessageId: null };
  const pending = beginPendingConversation({ scope: "test", destination: { workspaceId: "workspace" }, submitted });
  let attempts = 0;
  let published = false;
  const session = () => usePendingConversationStore.getState().conversations[pending.id];
  try {
    await createPendingConversation(pending.id, async () => {
      attempts++;
      throw new Error(JSON.stringify({ code: "sandbox_engine_policy_pending" }));
    }, () => { published = true; });
    expect(session()).toMatchObject({ phase: "sandbox-deferred", error: null, submitted, sandboxNote: "Your sandbox setting applies when current tasks finish. Send this again then." });
    expect(withPendingSessionPublication({}, usePendingConversationStore.getState().conversations, "test")).toEqual({});
    await retryPendingConversation(pending.id, { ...submitted, draft: "Edited draft" });
    expect(session()).toMatchObject({ phase: "sandbox-deferred", submitted: { draft: "Edited draft" } });
    expect(attempts).toBe(2);
    expect(published).toBe(false);
  } finally {
    usePendingConversationStore.setState({ conversations: {} });
  }
});
