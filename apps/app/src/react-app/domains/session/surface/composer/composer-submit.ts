export type ComposerSubmitAction = "send" | "queue" | "steer" | null;

/**
 * What an editor submit does with the draft. Enter sends while idle; while
 * busy Enter queues until the agent finishes and Cmd/Ctrl+Enter (`steer`)
 * sends as soon as the turn is admitted. An edit always replaces its original
 * turn through the immediate send path.
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
  steer: boolean;
}): ComposerSubmitAction {
  if (!input.hasContent || input.disabled) return null;
  // A new Enter after Stop is fresh work, not a follow-up to the interrupted
  // turn. The immediate send path fences admission on the shared interruption
  // promise; dropping Enter here silently leaves the person's draft unsent.
  if (input.stopping) return input.submissionPreparing ? null : "send";
  if (input.busy && !input.editing) return input.steer ? "steer" : "queue";
  return input.submissionPreparing ? null : "send";
}
