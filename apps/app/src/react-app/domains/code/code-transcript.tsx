/** @jsxImportSource react */
import { useState } from "react";
import { BrainCircuit, ChevronRight, Terminal } from "lucide-react";

import { MarkdownBlock } from "@/components/markdown/markdown";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ImportedMessage, ImportedToolCall } from "@/app/lib/code-sessions";

/** The head of a transcript can only show what fits; the file keeps everything. */
const MAX_TOOL_TEXT = 4_000;

function withCap(text: string): string {
  return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n… truncated` : text;
}

/** One short label for a tool call, from the argument the person would name. */
function toolSummary(call: ImportedToolCall): string {
  const input = call.input;
  const preferred = ["command", "file_path", "path", "pattern", "query", "url", "description"];
  for (const key of preferred) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return call.name;
}

function ToolRow({ call }: { call: ImportedToolCall }) {
  const summary = toolSummary(call);
  return (
    <Collapsible className="min-w-0">
      <CollapsibleTrigger
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Terminal className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium">{call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{summary}</span>
        {call.failed ? (
          <span className="shrink-0 text-xs text-destructive">Failed</span>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 px-2 pb-2 pt-1">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Input</p>
            <pre className="overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
              {withCap(JSON.stringify(call.input, null, 2))}
            </pre>
          </div>
          {call.output ? (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Output</p>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
                {withCap(call.output)}
              </pre>
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ReasoningRow({ text }: { text: string }) {
  return (
    <Collapsible className="min-w-0">
      <CollapsibleTrigger
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <BrainCircuit className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm">Thinking</span>
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="px-2 pb-2 pt-1 text-sm whitespace-pre-wrap text-muted-foreground">{text}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A read-only rendering of one mirrored coding-agent transcript. The neutral
 * message shape is shared with Claude history import, so this view works for
 * every client whose adapter transcodes into it.
 */
export function CodeTranscript({ messages }: { messages: ImportedMessage[] }) {
  return (
    <div className="flex flex-col gap-5">
      {messages.map((message) => {
        if (message.role === "user") {
          return (
            <div key={message.sourceId} className="border-l-2 border-primary/60 pl-3">
              <p className="text-sm whitespace-pre-wrap text-foreground">{message.text}</p>
            </div>
          );
        }
        return (
          <div key={message.sourceId} className="flex min-w-0 flex-col gap-2">
            {message.blocks.map((block, index) => {
              if (block.type === "text") {
                return (
                  <MarkdownBlock key={index} className="text-sm text-foreground" text={block.text} />
                );
              }
              if (block.type === "reasoning") {
                return <ReasoningRow key={index} text={block.text} />;
              }
              return <ToolRow key={index} call={block.call} />;
            })}
          </div>
        );
      })}
    </div>
  );
}
