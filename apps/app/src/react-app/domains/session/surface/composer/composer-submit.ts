export type ComposerSubmitAction = "send" | "queue" | "steer" | null;

/**
 * What an editor submit does with the draft. Enter sends while idle; while
 * busy Enter queues until the agent finishes and Cmd/Ctrl+Enter (`modifier`)
 * sends as soon as the turn is admitted (`steer`). Settings can swap the two
 * (`followUpDefault: "steer"`). An edit always replaces its original turn
 * through the immediate send path.
 *
 * Starting a turn (`submissionPreparing` while busy) must not swallow
 * follow-ups; only a fresh immediate send waits for preparation.
 */
export function resolveComposerSubmit(input: {
  hasContent: boolean;
  disabled: boolean;
  busy: boolean;
  editing: boolean;
  stopping: boolean;
  submissionPreparing: boolean;
  /** Cmd/Ctrl was held: do the follow-up that is not the default. */
  modifier: boolean;
  followUpDefault?: "queue" | "steer";
}): ComposerSubmitAction {
  if (!input.hasContent || input.disabled) return null;
  // A new Enter after Stop is fresh work, not a follow-up to the interrupted
  // turn. The immediate send path fences admission on the shared interruption
  // promise; dropping Enter here silently leaves the person's draft unsent.
  if (input.stopping) return input.submissionPreparing ? null : "send";
  if (input.busy && !input.editing) return (input.followUpDefault === "steer") !== input.modifier ? "steer" : "queue";
  return input.submissionPreparing ? null : "send";
}
