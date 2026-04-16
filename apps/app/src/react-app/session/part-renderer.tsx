import type { Part } from "@opencode-ai/sdk/v2/client";
import { FileCode2 } from "lucide-react";
import { Streamdown } from "streamdown";

import { safeStringify, summarizeStep } from "../../app/utils";

type PartRendererProps = {
  part: Part;
  tone: "user" | "assistant";
  isStreaming?: boolean;
};

const getText = (part: Part) => {
  const record = part as Part & Record<string, unknown>;
  return typeof record.text === "string" ? record.text : "";
};

export function PartRenderer({ part, tone, isStreaming = false }: PartRendererProps) {
  if (part.type === "text") {
    const text = getText(part);
    if (!text.trim()) return null;

    return (
      <div className={tone === "user" ? "ow-user-markdown" : "ow-markdown"}>
        <Streamdown animated={tone === "assistant"} isAnimating={tone === "assistant" && isStreaming}>
          {text}
        </Streamdown>
      </div>
    );
  }

  if (part.type === "reasoning") {
    const text = getText(part).trim();
    if (!text) return null;

    return (
      <details className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700" open={isStreaming}>
        <summary className="cursor-pointer list-none font-medium text-slate-900">Reasoning trace</summary>
        <div className="ow-markdown mt-3">
          <Streamdown>{text}</Streamdown>
        </div>
      </details>
    );
  }

  if (part.type === "file") {
    const record = part as Part & Record<string, unknown>;
    const filename = typeof record.filename === "string" ? record.filename : part.id;
    const url = typeof record.url === "string" ? record.url : "";
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <span className="ow-icon-tile h-9 w-9 text-slate-700">
          <FileCode2 className="h-4 w-4" />
        </span>
        <div>
          <div className="font-medium text-slate-900">{filename}</div>
          {url ? <div className="text-xs uppercase tracking-[0.18em] text-slate-400">{url}</div> : null}
        </div>
      </div>
    );
  }

  const summary = summarizeStep(part);
  const record = part as Record<string, unknown>;
  const payload = safeStringify(record.state ?? record) || "{}";

  return (
    <details className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      <summary className="cursor-pointer list-none font-medium text-slate-900">
        {summary.title}
        {summary.detail ? <span className="ml-2 text-slate-500">{summary.detail}</span> : null}
      </summary>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-white p-3 font-mono text-xs leading-6 text-slate-600">
        {payload}
      </pre>
    </details>
  );
}
