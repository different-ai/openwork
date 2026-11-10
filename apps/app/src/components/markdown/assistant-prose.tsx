import type { ComponentProps } from "react";
import { copyAssistantProseSelection } from "./assistant-prose-clipboard";

type AssistantProseProps = Omit<ComponentProps<"div">, "onCopy"> & {
  enabled: boolean;
  grouped?: boolean;
  onCopied?: () => void;
};

/** A message-level listener reads marked prose groups, never activity between them. */
export function AssistantProse({ enabled, grouped = false, onCopied, ...props }: AssistantProseProps) {
  return (
    <div
      {...props}
      data-assistant-reply-prose={grouped ? undefined : ""}
      onCopy={enabled ? (event) => {
        if (copyAssistantProseSelection(event.nativeEvent, event.currentTarget, true, grouped)) onCopied?.();
      } : undefined}
    />
  );
}
