export type ComposerSubmitAction = "send" | "queue" | "steer" | null;

export function resolveComposerSubmit(input: {
  hasContent: boolean;
  disabled: boolean;
  busy: boolean;
  editing: boolean;
  stopping: boolean;
  submissionPreparing: boolean;
  modifier: boolean;
  followUpDefault?: "queue" | "steer";
}): ComposerSubmitAction {
  if (!input.hasContent || input.disabled) return null;
  if (input.stopping) return input.submissionPreparing ? null : "send";
  if (input.busy && !input.editing) return (input.followUpDefault === "steer") !== input.modifier ? "steer" : "queue";
  return input.submissionPreparing ? null : "send";
}
