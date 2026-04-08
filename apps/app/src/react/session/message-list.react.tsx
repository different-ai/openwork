/** @jsxImportSource react */
import { useState } from "react";
import { isToolUIPart, type DynamicToolUIPart, type UIMessage } from "ai";

import { MarkdownBlock } from "./markdown.react";
import { ToolCallView } from "./tool-call.react";

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center justify-center rounded-lg border border-dls-border bg-dls-surface p-1.5 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
      title="Copy message"
      onClick={async () => {
        await navigator.clipboard.writeText(props.text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
      )}
    </button>
  );
}

function isImageAttachment(mime: string) {
  return mime.startsWith("image/");
}

function messageToText(message: UIMessage) {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "reasoning") return [part.text];
      if (part.type === "file") return [part.filename ?? part.url];
      if (isToolUIPart(part)) {
        const toolName = part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
        if (part.state === "output-error") return [`[tool:${toolName}] ${part.errorText}`];
        if (part.state === "output-available") return [`[tool:${toolName}] ${JSON.stringify(part.output)}`];
        return [`[tool:${toolName}] ${JSON.stringify(part.input)}`];
      }
      return [];
    })
    .join("\n\n")
    .trim();
}

async function copyMessage(message: UIMessage) {
  await navigator.clipboard.writeText(messageToText(message));
}

function latestAssistantMessageId(messages: UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.id;
  }
  return null;
}

function humanMediaType(raw: string) {
  if (!raw || raw === "application/octet-stream") return null;
  const short = raw.replace(/^application\//, "").replace(/^text\//, "");
  return short.toUpperCase();
}

function isDesktopRuntime() {
  try {
    return Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
  } catch {
    return false;
  }
}

async function openFileWithOS(path: string) {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  } catch {
    // silently fail on web
  }
}

async function revealFileInFinder(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch {
    // silently fail on web
  }
}

function FileCard(props: { part: { filename?: string; url: string; mediaType: string }; tone: "assistant" | "user" }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isDataUrl = props.part.url?.startsWith("data:");
  const title = props.part.filename || (isDataUrl ? "Attached file" : props.part.url) || "File";
  const ext = props.part.filename?.split(".").pop()?.toLowerCase();
  const badge = humanMediaType(props.part.mediaType) ?? (ext ? ext.toUpperCase() : null);
  const isImage = isImageAttachment(props.part.mediaType ?? "");
  const isDesktop = isDesktopRuntime();
  const hasPath = !isDataUrl && props.part.url && !props.part.url.startsWith("http");

  return (
    <div
      className={`group relative flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${
        props.tone === "user"
          ? "border-gray-6/60 bg-gray-2/40 hover:bg-gray-2/60"
          : "border-gray-6/40 bg-gray-1/40 hover:bg-gray-2/30"
      }`}
    >
      {isImage && props.part.url ? (
        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-dls-border/60 bg-dls-surface">
          <img src={props.part.url} alt={title} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        </div>
      ) : (
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${props.tone === "user" ? "bg-gray-3/60 text-gray-11" : "bg-gray-2/60 text-gray-10"}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium leading-snug text-gray-12">{title}</div>
        {badge ? (
          <div className="mt-1 inline-flex rounded-md bg-gray-3/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-10">{badge}</div>
        ) : null}
      </div>

      {isDesktop && hasPath ? (
        <div className="relative">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-xl text-gray-9 opacity-0 transition-all hover:bg-gray-3/60 hover:text-gray-12 group-hover:opacity-100"
            onClick={() => setMenuOpen((v) => !v)}
            title="File actions"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
          {menuOpen ? (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-2xl border border-dls-border bg-dls-surface p-1.5 shadow-lg">
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-gray-12 transition-colors hover:bg-gray-3/60"
                  onClick={() => {
                    void openFileWithOS(props.part.url);
                    setMenuOpen(false);
                  }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                  Open with default app
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-gray-12 transition-colors hover:bg-gray-3/60"
                  onClick={() => {
                    void revealFileInFinder(props.part.url);
                    setMenuOpen(false);
                  }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12h4"/></svg>
                  Reveal in Finder
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-gray-12 transition-colors hover:bg-gray-3/60"
                  onClick={() => {
                    void navigator.clipboard.writeText(props.part.url);
                    setMenuOpen(false);
                  }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                  Copy path
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
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
        <div className="absolute -top-3 right-0 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={messageToText(props.message)} />
        </div>
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
              return null;
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
      <div className="group relative max-w-[85%] rounded-[24px] border border-dls-border bg-dls-sidebar px-6 py-4 text-[15px] leading-relaxed text-dls-text">
        <div className="absolute -top-3 right-2 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={messageToText(props.message)} />
        </div>
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
