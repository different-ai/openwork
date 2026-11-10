import type { ComponentProps } from "react";
import { copyAssistantProseSelection } from "./assistant-prose-clipboard";

type AssistantProseProps = Omit<ComponentProps<"div">, "onCopy"> & {
  enabled: boolean;
  onCopied?: () => void;
};

/** Mount only around assistant text, not reasoning, tools, user messages or the composer. */
export function AssistantProse({ enabled, onCopied, ...props }: AssistantProseProps) {
  return (
    <div
      {...props}
      data-assistant-reply-prose=""
      onCopy={enabled ? (event) => {
        if (copyAssistantProseSelection(event.nativeEvent, event.currentTarget, true)) onCopied?.();
      } : undefined}
    />
  );
}
