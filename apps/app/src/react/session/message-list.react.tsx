/** @jsxImportSource react */
import { isToolUIPart, type DynamicToolUIPart, type UIMessage } from "ai";

import { MarkdownBlock } from "./markdown.react";
import { ToolCallView } from "./tool-call.react";

function isImageAttachment(mime: string) {
  return mime.startsWith("image/");
}

function latestAssistantMessageId(messages: UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.id;
  }
  return null;
}

function FileCard(props: { part: { filename?: string; url: string; mediaType: string }; tone: "assistant" | "user" }) {
  const title = props.part.filename || props.part.url || "File";
  const detail = props.part.url || "";
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
        props.tone === "user" ? "border-gray-6 bg-gray-1/60" : "border-gray-6/70 bg-gray-2/40"
      }`}
    >
      {props.part.url && isImageAttachment(props.part.mediaType ?? "") ? (
        <div className="h-12 w-12 overflow-hidden rounded-xl border border-dls-border bg-dls-sidebar">
          <img src={props.part.url} alt={props.part.filename ?? ""} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        </div>
      ) : (
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${props.tone === "user" ? "bg-gray-12/10 text-gray-12" : "bg-gray-2/70 text-gray-11"}`}>
          <span className="text-sm">📄</span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-12">{title}</div>
        {detail ? <div className="truncate text-[11px] text-gray-11">{detail}</div> : null}
      </div>
      {props.part.mediaType ? <div className="max-w-[160px] truncate rounded-full bg-gray-1/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-9">{props.part.mediaType}</div> : null}
    </div>
  );
}

function ReasoningBlock(props: { text: string; developerMode: boolean }) {
  const text = props.text.trim();
  if (!props.developerMode || !text) return null;
  return (
    <details className="rounded-lg bg-gray-2/30 p-2">
      <summary className="cursor-pointer text-xs text-gray-11">Thinking</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-gray-12">{text}</pre>
    </details>
  );
}

function AssistantBlock(props: { message: UIMessage; developerMode: boolean; isStreaming: boolean }) {
  return (
    <article className="flex justify-start" data-message-role="assistant" data-message-id={props.message.id}>
      <div className="group relative w-full max-w-[760px] text-[15px] leading-[1.72] text-dls-text antialiased">
        <div className="space-y-4">
          {props.message.parts.map((part, index) => {
            if (part.type === "text") {
              return (
                <MarkdownBlock
                  key={`${props.message.id}-text-${index}`}
                  text={part.text}
                  streaming={props.isStreaming && part.state === "streaming"}
                />
              );
            }

            if (part.type === "file") {
              return <FileCard key={`${props.message.id}-file-${index}`} part={part} tone="assistant" />;
            }

            if (part.type === "reasoning") {
              return <ReasoningBlock key={`${props.message.id}-reasoning-${index}`} text={part.text} developerMode={props.developerMode} />;
            }

            if (part.type === "step-start") {
              return <div key={`${props.message.id}-step-${index}`} className="text-[11px] uppercase tracking-[0.12em] text-gray-8">Step started</div>;
            }

            if (isToolUIPart(part)) {
              const toolPart = (part.type === "dynamic-tool"
                ? part
                : ({
                    ...part,
                    toolName: part.type.replace(/^tool-/, ""),
                    type: "dynamic-tool",
                  } as DynamicToolUIPart));
              return (
                <div key={`${props.message.id}-tool-${index}`} className="mt-4 flex flex-col gap-4">
                  <ToolCallView part={toolPart} developerMode={props.developerMode} />
                </div>
              );
            }

            return null;
          })}
        </div>
      </div>
    </article>
  );
}

function UserBlock(props: { message: UIMessage }) {
  const attachments = props.message.parts.filter((part) => part.type === "file");
  const text = props.message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");

  return (
    <article className="flex justify-end" data-message-role="user" data-message-id={props.message.id}>
      <div className="relative max-w-[85%] rounded-[24px] border border-dls-border bg-dls-sidebar px-6 py-4 text-[15px] leading-relaxed text-dls-text">
        {attachments.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachments.map((part, index) => (
              <FileCard key={`${props.message.id}-attachment-${index}`} part={part} tone="user" />
            ))}
          </div>
        ) : null}
        <div className="whitespace-pre-wrap break-words text-gray-12">{text}</div>
      </div>
    </article>
  );
}

export function SessionTranscript(props: {
  messages: UIMessage[];
  isStreaming: boolean;
  developerMode: boolean;
}) {
  const latestAssistantId = latestAssistantMessageId(props.messages);
  return (
    <div className="space-y-4 pb-4">
      {props.messages.map((message) =>
        message.role === "user" ? (
          <UserBlock key={message.id} message={message} />
        ) : (
          <AssistantBlock
            key={message.id}
            message={message}
            developerMode={props.developerMode}
            isStreaming={props.isStreaming && message.id === latestAssistantId}
          />
        ),
      )}
    </div>
  );
}
