import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { useComposerStateStore } from "../../apps/app/src/react-app/domains/session/surface/composer-state-store";

test("persisted composer draft hydration is idempotent", () => {
  useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {} });
  const { hydrateDraft, replaceDraft, setAttachments, setMentions, setPasteParts } = useComposerStateStore.getState();
  let notifications = 0;
  const unsubscribe = useComposerStateStore.subscribe(() => notifications += 1);

  replaceDraft("session-a", "stale draft", "message-a");
  setAttachments("session-a", [{
    id: "attachment-a",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    kind: "file",
    file: new File(["notes"], "notes.txt", { type: "text/plain" }),
  }]);
  setMentions("session-a", { "@notes": "file" });
  setPasteParts("session-a", [{ id: "paste-a", label: "Pasted text", text: "notes", lines: 1 }]);

  hydrateDraft("session-a", "persisted draft");
  const hydratedState = useComposerStateStore.getState();
  const notificationsAfterHydration = notifications;
  hydrateDraft("session-a", "persisted draft");

  expect(hydratedState.sessions["session-a"]).toEqual({
    draft: "persisted draft",
    attachments: [],
    mentions: {},
    pasteParts: [],
    revertMessageId: null,
  });
  expect(useComposerStateStore.getState()).toBe(hydratedState);
  expect(notifications).toBe(notificationsAfterHydration);
  unsubscribe();
});
