/** @jsxImportSource react */
import type { Part } from "@opencode-ai/sdk/v2/client";

import type { OpenworkSessionMessage } from "../../app/lib/openwork-server";
import { groupMessageParts, isUserVisiblePart } from "../../app/utils";
import { MarkdownBlock } from "./markdown.react";
import { ToolCallView } from "./tool-call.react";

function isImageAttachment(mime: string) {
  return mime.startsWith("image/");
}

function roleIsUser(message: OpenworkSessionMessage) {
  return message.info.role === "user";
}

function latestAssistantMessageId(messages: OpenworkSessionMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.info.role === "assistant") {
      return message.info.id;
    }
  }
  return null;
}

function textFromUserPart(part: Part) {
  if (part.type === "text") return typeof (part as { text?: string }).text === "string" ? (part as { text: string }).text : "";
  if (part.type === "agent") return `@${String((part as { name?: string }).name ?? "agent")}`;
  return "";
}

function FileCard(props: { part: Part; tone: "assistant" | "user" }) {
  const record = props.part as Part & {
    filename?: string;
    url?: string;
    mime?: string;
    source?: { path?: string; name?: string; clientName?: string; uri?: string; type?: string };
  };
  const title = record.filename || record.source?.path?.split(/[\\/]/).pop() || record.source?.name || record.url || "File";
  const detail = record.source?.path || record.source?.uri || record.url || "";
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
        props.tone === "user" ? "border-gray-6 bg-gray-1/60" : "border-gray-6/70 bg-gray-2/40"
      }`}
    >
      {record.url && isImageAttachment(record.mime ?? "") ? (
        <div className="h-12 w-12 overflow-hidden rounded-xl border border-dls-border bg-dls-sidebar">
          <img src={record.url} alt={record.filename ?? ""} loading="lazy" decoding="async" className="h-full w-full object-cover" />
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
      {record.mime ? <div className="max-w-[160px] truncate rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-9 bg-gray-1/70">{record.mime}</div> : null}
    </div>
  );
}

function ReasoningBlock(props: { part: Part; developerMode: boolean }) {
  const text = typeof (props.part as { text?: string }).text === "string" ? (props.part as { text: string }).text.trim() : "";
  if (!props.developerMode || !text) return null;
  return (
    <details className="rounded-lg bg-gray-2/30 p-2">
      <summary className="cursor-pointer text-xs text-gray-11">Thinking</summary>
      <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-gray-12">{text}</pre>
    </details>
  );
}

function AssistantBlock(props: { message: OpenworkSessionMessage; streaming: boolean; developerMode: boolean }) {
  const visibleParts = props.message.parts.filter(isUserVisiblePart);
  const groups = groupMessageParts(visibleParts, props.message.info.id);
  return (
    <article className="flex justify-start" data-message-role="assistant" data-message-id={props.message.info.id}>
      <div className="group relative w-full max-w-[760px] text-[15px] leading-[1.72] text-dls-text antialiased">
        <div className="space-y-4">
          {groups.map((group, groupIndex) => {
            if (group.kind === "text") {
              const part = group.part;
              if (part.type === "file") {
                return <FileCard key={`${props.message.info.id}-file-${groupIndex}`} part={part} tone="assistant" />;
              }
              if (part.type !== "text") return null;
              const text = typeof (part as { text?: string }).text === "string" ? (part as { text: string }).text : "";
              return (
                <MarkdownBlock
                  key={`${props.message.info.id}-text-${groupIndex}`}
                  text={text}
                  streaming={props.streaming && groupIndex === groups.length - 1}
                />
              );
            }
            return (
              <div key={`${props.message.info.id}-steps-${group.id}`} className="mt-4 flex flex-col gap-4">
                {group.parts.map((part, index) => {
                  if (part.type === "reasoning") {
                    return <ReasoningBlock key={`${group.id}-reasoning-${index}`} part={part} developerMode={props.developerMode} />;
                  }
                  return <ToolCallView key={`${group.id}-tool-${index}`} part={part} developerMode={props.developerMode} />;
                })}
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}

function UserBlock(props: { message: OpenworkSessionMessage }) {
  const attachments = props.message.parts.filter((part) => part.type === "file");
  const text = props.message.parts.filter((part) => part.type === "text" || part.type === "agent").map(textFromUserPart).join("");

  return (
    <article className="flex justify-end" data-message-role="user" data-message-id={props.message.info.id}>
      <div className="relative max-w-[85%] rounded-[24px] border border-dls-border bg-dls-sidebar px-6 py-4 text-[15px] leading-relaxed text-dls-text">
        {attachments.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachments.map((part) => (
              <FileCard key={part.id} part={part} tone="user" />
            ))}
          </div>
        ) : null}
        <div className="whitespace-pre-wrap break-words text-gray-12">{text}</div>
      </div>
    </article>
  );
}

export function SessionTranscript(props: {
  messages: OpenworkSessionMessage[];
  isStreaming: boolean;
  developerMode: boolean;
}) {
  const latestAssistantId = latestAssistantMessageId(props.messages);
  return (
    <div className="space-y-4 pb-4">
      {props.messages.map((message) =>
        roleIsUser(message) ? (
          <UserBlock key={message.info.id} message={message} />
        ) : (
          <AssistantBlock
            key={message.info.id}
            message={message}
            developerMode={props.developerMode}
            streaming={props.isStreaming && message.info.id === latestAssistantId}
          />
        ),
      )}
    </div>
  );
}
