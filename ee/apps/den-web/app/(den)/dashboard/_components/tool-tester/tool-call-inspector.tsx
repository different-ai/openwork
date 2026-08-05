"use client";

import { useState } from "react";
import { Check, CircleCheck, CircleX, LockKeyhole, X } from "lucide-react";
import { UnderlineTabs } from "../../../_components/ui/tabs";
import {
  type ExternalMcpInspectionBody,
  type ExternalMcpInspectionHeader,
  type ExternalMcpTool,
  type ExternalMcpToolCallInspection,
} from "../mcp-connections-data";
import type { ExternalMcpFailureAttribution } from "../mcp-tool-error-attribution";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function placeholderValue(definition: unknown): unknown {
  if (!isRecord(definition)) return null;
  if ("default" in definition) return definition.default;
  if (Array.isArray(definition.enum) && definition.enum.length > 0) return definition.enum[0];
  if (definition.type === "string") return "";
  if (definition.type === "integer" || definition.type === "number") return 0;
  if (definition.type === "boolean") return false;
  if (definition.type === "array") return [];
  if (definition.type === "object") return {};
  return null;
}

export function mcpToolArgumentTemplate(tool: ExternalMcpTool): Record<string, unknown> {
  const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const required = new Set(
    Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([name]) => required.has(name))
      .map(([name, definition]) => [name, placeholderValue(definition)]),
  );
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

export function InspectionHeaders({ headers }: { headers: ExternalMcpInspectionHeader[] }) {
  if (headers.length === 0) return <p className="text-[11px] text-gray-400">No headers captured.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      {headers.map((header, index) => (
        <div key={`${index}-${header.name}`} className="grid grid-cols-[minmax(7rem,0.7fr)_minmax(0,1.3fr)] gap-3 border-b border-gray-100 px-3 py-2 last:border-b-0">
          <code className="break-all text-[10px] font-semibold text-gray-600">{header.name}</code>
          <code className="break-all text-[10px] text-gray-800">
            {header.redacted ? <LockKeyhole className="mr-1 inline h-3 w-3 text-amber-600" aria-hidden="true" /> : null}
            {header.value}
          </code>
        </div>
      ))}
    </div>
  );
}

export function InspectionBody({ body }: { body: ExternalMcpInspectionBody }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-gray-500">
        <span>Raw body</span>
        <span>
          {formatBytes(body.bytes)}
          {body.truncated ? <span className="ml-1 font-semibold text-amber-700">· capture truncated</span> : null}
        </span>
      </div>
      {body.unavailable ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">The transport body could not be captured.</div>
      ) : (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-950 p-3 text-[10px] leading-4 text-gray-100">{body.text || "(empty body)"}</pre>
      )}
    </div>
  );
}

export function diagnosisLayerLabel(layer: ExternalMcpToolCallInspection["diagnosis"]["layer"]): string {
  if (layer === "micx") return "Micx before send";
  if (layer === "network") return "Network / no response";
  if (layer === "mcp_connection") return "MCP connection / setup";
  if (layer === "remote_http") return "Remote MCP HTTP";
  return "MCP tool response";
}

export type McpToolCallOutcome = {
  status: "completed" | "failed";
  referenceId: string;
  durationMs: number;
  result: unknown;
  inspection: ExternalMcpToolCallInspection | null;
  failureAttribution: ExternalMcpFailureAttribution | null;
  errorMessage: string | null;
};

type HopState = "succeeded" | "failed" | "unreached";

function transportLabel(inspection: ExternalMcpToolCallInspection | null): string {
  if (inspection?.response) return `HTTP ${inspection.response.status}`;
  if (inspection?.request && inspection.diagnosis.layer !== "micx") return "No response";
  return "Not sent";
}

function traceStates(outcome: McpToolCallOutcome): [HopState, HopState, HopState] {
  if (outcome.status === "completed") return ["succeeded", "succeeded", "succeeded"];
  const inspection = outcome.inspection;
  if (!inspection || inspection.diagnosis.layer === "micx") return ["failed", "unreached", "unreached"];
  if (inspection.diagnosis.layer === "mcp_tool") return ["succeeded", "succeeded", "failed"];
  if (inspection.diagnosis.layer === "mcp_connection" && !inspection.request) return ["failed", "unreached", "unreached"];
  return ["succeeded", "failed", "unreached"];
}

function TracePill({ label, state }: { label: string; state: HopState }) {
  const className = state === "succeeded"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : state === "failed"
      ? "border-red-200 bg-red-50 text-red-800"
      : "border-dashed border-gray-300 bg-white text-gray-400";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium ${className}`}>
      {state === "succeeded" ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
      {state === "failed" ? <X className="h-3 w-3" aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

function DetailsUnavailable() {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] leading-5 text-amber-800" role="status">
      Request and response details were unavailable. Refresh after the dashboard and its server are running the same version.
    </div>
  );
}

function RedactionNotice() {
  return (
    <div className="rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-2 text-[10px] leading-4 text-amber-800">
      Credential and session headers are redacted. Bodies may contain sensitive provider data; this inspection is returned only for this run and is not stored in Micx logs.
    </div>
  );
}

function RequestInspection({ inspection }: { inspection: ExternalMcpToolCallInspection | null }) {
  if (!inspection) return <DetailsUnavailable />;
  return (
    <div className="space-y-4">
      <RedactionNotice />
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Outgoing request</p>
        {inspection.request ? (
          <div className="mt-2 rounded-lg bg-gray-950 px-3 py-2 font-mono text-[10px] leading-4 text-gray-100">
            <span className="font-semibold text-blue-300">{inspection.request.method}</span> <span className="break-all">{inspection.request.url}</span>
          </div>
        ) : (
          <p className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">No tools/call request left Micx.</p>
        )}
      </div>
      {inspection.request ? (
        <>
          <div><p className="mb-1.5 text-[11px] font-medium text-gray-700">Headers</p><InspectionHeaders headers={inspection.request.headers} /></div>
          <InspectionBody body={inspection.request.body} />
        </>
      ) : null}
    </div>
  );
}

function ResponseInspection({ inspection }: { inspection: ExternalMcpToolCallInspection | null }) {
  if (!inspection) return <DetailsUnavailable />;
  return (
    <div className="space-y-4">
      <RedactionNotice />
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Response received</p>
        {inspection.response ? (
          <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-gray-950 px-3 py-2 font-mono text-[10px] text-gray-100">
            <span><span className={inspection.response.status < 400 ? "text-emerald-300" : "text-red-300"}>HTTP {inspection.response.status}</span> {inspection.response.statusText}</span>
            <span className="text-gray-400">{inspection.response.durationMs} ms</span>
          </div>
        ) : (
          <p className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">No HTTP response was captured.</p>
        )}
      </div>
      {inspection.response ? (
        <>
          <div><p className="mb-1.5 text-[11px] font-medium text-gray-700">Headers</p><InspectionHeaders headers={inspection.response.headers} /></div>
          <InspectionBody body={inspection.response.body} />
        </>
      ) : null}
    </div>
  );
}

export function McpToolCallInspector({ outcome }: { outcome: McpToolCallOutcome }) {
  const [activeTab, setActiveTab] = useState<"result" | "request" | "response">("result");
  const succeeded = outcome.status === "completed";
  const summary = outcome.failureAttribution?.likelySource
    ?? outcome.inspection?.diagnosis.summary
    ?? outcome.errorMessage;
  const states = traceStates(outcome);
  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white" aria-label="Tool call inspection">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {succeeded
            ? <CircleCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            : <CircleX className="h-4 w-4 text-red-500" aria-hidden="true" />}
          <p className="text-[13px] font-semibold text-gray-900">{succeeded ? "Tool completed" : "Tool call failed"}</p>
          {!succeeded && summary ? <p className="text-[12px] text-gray-600">· {summary}</p> : null}
          {!succeeded && outcome.failureAttribution ? (
            <span className="rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">{outcome.failureAttribution.confidence}</span>
          ) : null}
        </div>
        <p className="font-mono text-[10px] text-gray-500">{outcome.referenceId} · {outcome.durationMs} ms</p>
      </div>

      <div className="flex flex-wrap items-center px-4 py-3">
        <TracePill label="Micx" state={states[0]} />
        <span className="h-px w-6 bg-gray-200" aria-hidden="true" />
        <TracePill label={transportLabel(outcome.inspection)} state={states[1]} />
        <span className="h-px w-6 bg-gray-200" aria-hidden="true" />
        <TracePill label="Tool result" state={states[2]} />
      </div>

      <UnderlineTabs
        className="px-4"
        tabs={[
          { value: "result", label: "Result" },
          { value: "request", label: "Request" },
          { value: "response", label: "Response" },
        ]}
        activeTab={activeTab}
        onChange={setActiveTab}
      />
      <div className="p-4">
        {activeTab === "result" ? (
          <div className="space-y-2">
            <pre className="max-h-80 overflow-auto rounded-xl bg-gray-950 p-3 text-[11px] leading-[18px] text-gray-100">{formatJson(outcome.result)}</pre>
            <p className="inline-flex items-center gap-1.5 text-[10px] text-gray-500">
              <LockKeyhole className="h-3 w-3" aria-hidden="true" /> Credential headers redacted. Returned only for this run — never stored in Micx logs.
            </p>
          </div>
        ) : activeTab === "request" ? (
          <RequestInspection inspection={outcome.inspection} />
        ) : (
          <ResponseInspection inspection={outcome.inspection} />
        )}
      </div>
    </section>
  );
}
