/** @jsxImportSource react */
import { useMemo, useState } from "react";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { safeStringify, summarizeStep } from "../../app/utils";

function normalizeToolText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.replace(/(?:\r?\n\s*)+$/, "");
}

function hasStructuredValue(value: unknown) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function formatStructuredValue(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function diffLineClass(line: string) {
  if (line.startsWith("+")) return "text-green-11 bg-green-1/40";
  if (line.startsWith("-")) return "text-red-11 bg-red-1/40";
  if (line.startsWith("@@")) return "text-blue-11 bg-blue-1/30";
  return "text-gray-12";
}

function extractDiff(state: Record<string, unknown>) {
  const candidates = [state.diff, state.patch, state.output];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (candidate.includes("@@") || candidate.includes("+++ ") || candidate.includes("--- ")) {
      return candidate;
    }
  }
  return null;
}

export function ToolCallView(props: { part: Part; developerMode: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const record = props.part as Part & { tool?: string; state?: Record<string, unknown> };
  const state = (record.state ?? {}) as Record<string, unknown>;
  const summary = useMemo(() => summarizeStep(props.part), [props.part]);
  const title = summary.title?.trim() || String(record.tool ?? "Tool");
  const subtitle = summary.detail?.trim() || "";
  const toolName = typeof record.tool === "string" ? record.tool : "tool";
  const status = typeof state.status === "string" ? state.status : "unknown";
  const input = state.input;
  const output = state.output;
  const error = typeof state.error === "string" ? state.error : "";
  const diff = extractDiff(state);
  const diffLines = diff ? normalizeToolText(diff).split("\n") : [];
  const expandable = hasStructuredValue(input) || hasStructuredValue(output) || Boolean(diff) || Boolean(error);

  return (
    <div className="grid gap-3 text-[14px] text-gray-9">
      <button
        type="button"
        className="w-full text-left transition-colors hover:text-dls-text disabled:cursor-default"
        aria-expanded={expandable ? expanded : undefined}
        disabled={!expandable}
        onClick={() => {
          if (!expandable) return;
          setExpanded((value) => !value);
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-gray-12">{title}</div>
            <div className="text-[11px] text-gray-11">{toolName}</div>
            {subtitle ? <div className="text-xs text-gray-11">{subtitle}</div> : null}
          </div>
          <div
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              status === "completed"
                ? "bg-green-3/15 text-green-12"
                : status === "running"
                  ? "bg-blue-3/15 text-blue-12"
                  : status === "error"
                    ? "bg-red-3/15 text-red-12"
                    : "bg-gray-2/10 text-gray-12"
            }`}
          >
            {status}
          </div>
        </div>
      </button>

      {expanded ? (
        <div className="space-y-3 pl-[22px]">
          {Boolean(diff) ? (
            <div className="rounded-lg border bg-gray-2/30 p-2">
              <div className="text-[11px] font-medium text-gray-11">Diff</div>
              <div className="mt-2 grid gap-1 overflow-hidden rounded-md">
                {diffLines.map((line, index) => (
                  <div
                    key={`${toolName}-diff-${index}`}
                    className={`whitespace-pre-wrap break-words px-2 py-0.5 font-mono text-[11px] leading-relaxed ${diffLineClass(line)}`}
                  >
                    {line || " "}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {hasStructuredValue(input) ? (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-8">Tool request</div>
              <pre className="overflow-x-auto rounded-[16px] border border-dls-border/70 bg-dls-surface px-4 py-3 text-[12px] leading-6 text-gray-10">
                {formatStructuredValue(input)}
              </pre>
            </div>
          ) : null}

          {hasStructuredValue(output) && normalizeToolText(output) !== normalizeToolText(diff) ? (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-gray-8">Tool result</div>
              <pre className="overflow-x-auto rounded-[16px] border border-dls-border/70 bg-dls-surface px-4 py-3 text-[12px] leading-6 text-gray-10">
                {formatStructuredValue(output)}
              </pre>
            </div>
          ) : null}

          {error ? <div className="rounded-lg bg-red-1/40 p-2 text-xs text-red-12">{error}</div> : null}

          {props.developerMode && !expandable ? (
            <pre className="overflow-x-auto rounded-[16px] border border-dls-border/70 bg-dls-surface px-4 py-3 text-[12px] leading-6 text-gray-10">
              {safeStringify(state)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
