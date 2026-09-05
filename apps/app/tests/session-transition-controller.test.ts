import { describe, expect, test } from "bun:test";

import { deriveSessionRenderModel } from "../src/react-app/domains/session/sync/transition-controller";

describe("session render transitions", () => {
  test("keeps an already-rendered current session interactive during background refresh", () => {
    expect(deriveSessionRenderModel({
      intendedSessionId: "session-current",
      renderedSessionId: "session-current",
      hasSnapshot: true,
      isFetching: true,
      isError: false,
    })).toEqual({
      intendedSessionId: "session-current",
      renderedSessionId: "session-current",
      transitionState: "idle",
      renderSource: "live",
    });
  });

  test("still reports switching while the intended session has no rendered snapshot", () => {
    expect(deriveSessionRenderModel({
      intendedSessionId: "session-next",
      renderedSessionId: null,
      hasSnapshot: false,
      isFetching: true,
      isError: false,
    }).transitionState).toBe("switching");
  });

  test("still reports switching when a different session remains rendered", () => {
    expect(deriveSessionRenderModel({
      intendedSessionId: "session-next",
      renderedSessionId: "session-previous",
      hasSnapshot: true,
      isFetching: true,
      isError: false,
    }).transitionState).toBe("switching");
  });
});
