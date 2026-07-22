import { beforeEach, describe, expect, test } from "bun:test";

import { useSessionFindStore } from "../src/react-app/domains/session/surface/find-store";

function resetFindStore() {
  useSessionFindStore.setState({
    open: false,
    sessionId: null,
    lastFocusedSessionId: null,
    query: "",
    appliedQuery: "",
    target: null,
    focusNonce: 0,
  });
}

describe("session find store", () => {
  beforeEach(resetFindStore);

  test("openFind sets owner, query, target, and bumps focus nonce", () => {
    const target = { sessionId: "session-a", messageId: "message-a" };
    useSessionFindStore.getState().openFind({
      sessionId: "session-a",
      query: "zebra",
      target,
    });

    const state = useSessionFindStore.getState();
    expect(state.open).toBe(true);
    expect(state.sessionId).toBe("session-a");
    expect(state.query).toBe("zebra");
    expect(state.appliedQuery).toBe("zebra");
    expect(state.target).toBe(target);
    expect(state.focusNonce).toBe(1);
  });

  test("openFind can move ownership to another session", () => {
    useSessionFindStore.getState().openFind({ sessionId: "session-a", query: "zebra" });
    useSessionFindStore.getState().openFind({ sessionId: "session-b" });

    const state = useSessionFindStore.getState();
    expect(state.open).toBe(true);
    expect(state.sessionId).toBe("session-b");
    expect(state.query).toBe("zebra");
    expect(state.focusNonce).toBe(2);
  });

  test("closeFind clears find state but keeps the last focused session", () => {
    const store = useSessionFindStore.getState();
    store.setLastFocused("session-a");
    store.openFind({ sessionId: "session-a", query: "zebra", target: { sessionId: "session-a" } });
    useSessionFindStore.getState().closeFind();

    const state = useSessionFindStore.getState();
    expect(state.open).toBe(false);
    expect(state.sessionId).toBeNull();
    expect(state.query).toBe("");
    expect(state.appliedQuery).toBe("");
    expect(state.target).toBeNull();
    expect(state.lastFocusedSessionId).toBe("session-a");
  });

  test("setLastFocused no-ops when the session is unchanged", () => {
    useSessionFindStore.getState().setLastFocused("session-a");
    const before = useSessionFindStore.getState();
    before.setLastFocused("session-a");

    expect(useSessionFindStore.getState()).toBe(before);
  });
});
