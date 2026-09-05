export type TransitionState = "idle" | "switching" | "recovering" | "failed";

export type RenderSource = "cache" | "live" | "empty" | "error" | "recovering";

export type SessionRenderModel = {
  intendedSessionId: string;
  renderedSessionId: string | null;
  transitionState: TransitionState;
  renderSource: RenderSource;
};

export function deriveSessionRenderModel(input: {
  intendedSessionId: string;
  renderedSessionId: string | null;
  hasSnapshot: boolean;
  isFetching: boolean;
  isError: boolean;
}): SessionRenderModel {
  if (input.isError && input.renderedSessionId && input.renderedSessionId !== input.intendedSessionId) {
    return {
      intendedSessionId: input.intendedSessionId,
      renderedSessionId: input.renderedSessionId,
      transitionState: "recovering",
      renderSource: "recovering",
    };
  }

  if (input.isError) {
    return {
      intendedSessionId: input.intendedSessionId,
      renderedSessionId: input.renderedSessionId,
      transitionState: "failed",
      renderSource: "error",
    };
  }

  if (input.renderedSessionId && input.renderedSessionId !== input.intendedSessionId) {
    return {
      intendedSessionId: input.intendedSessionId,
      renderedSessionId: input.renderedSessionId,
      transitionState: "switching",
      renderSource: "cache",
    };
  }

  if (!input.hasSnapshot) {
    return {
      intendedSessionId: input.intendedSessionId,
      renderedSessionId: input.renderedSessionId,
      transitionState: input.isFetching ? "switching" : "idle",
      renderSource: "empty",
    };
  }

  return {
    intendedSessionId: input.intendedSessionId,
    renderedSessionId: input.renderedSessionId,
    // A background refresh of the session already on screen is not a session
    // switch. Keeping it idle prevents the composer from becoming temporarily
    // non-editable (and losing focus) when a tool call or final message causes
    // the current snapshot to refetch.
    transitionState: "idle",
    renderSource: "live",
  };
}
