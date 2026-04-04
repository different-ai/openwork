import type { Part } from "@opencode-ai/sdk/v2/client";
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
      <details className="rounded-2xl border border-white/12 bg-black/18 p-3 text-sm text-slate-200/90" open={isStreaming}>
        <summary className="cursor-pointer list-none font-medium text-amber-100">Reasoning trace</summary>
        <div className="ow-markdown mt-3 opacity-85">
          <Streamdown>{text}</Streamdown>
        </div>
      </details>
    );
  }

  const summary = summarizeStep(part);
  const record = part as Record<string, unknown>;
  const payload = safeStringify(record.state ?? record) || "{}";

  return (
    <details className="rounded-2xl border border-white/12 bg-slate-950/55 p-3 text-sm text-slate-200/90">
      <summary className="cursor-pointer list-none font-medium text-slate-100">
        {summary.title}
        {summary.detail ? <span className="ml-2 text-slate-400">{summary.detail}</span> : null}
      </summary>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-xl bg-black/40 p-3 font-mono text-xs leading-6 text-slate-300">
        {payload}
      </pre>
    </details>
  );
}
