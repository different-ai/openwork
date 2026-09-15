import { useMemo } from "react";
import { splitChatReply } from "@/lib/chat-replies";
import { Markdown } from "./markdown";

export type ChatReplyProps = {
  text: string;
  live?: boolean;
  tail?: boolean;
  className?: string;
  "data-testid"?: string;
};

export function ChatReply({ text, live = false, tail = false, className = "", "data-testid": testId = "chat-reply-bubble" }: ChatReplyProps) {
  const parts = useMemo(() => splitChatReply(text), [text]);
  return (
    <div className={`flex min-w-0 flex-col items-start gap-1 ${className}`} data-live={live || undefined}>
      {parts.map((part, index) => (
        <div
          key={part.start}
          className={`bubble bubble-coworker min-w-0 max-w-full [overflow-wrap:anywhere] ${tail && index === parts.length - 1 ? "bubble-tail-left" : ""}`}
          data-testid={testId}
          data-bubble-index={index}
        >
          <Markdown text={part.markdown} className="overflow-x-auto" />
        </div>
      ))}
    </div>
  );
}
