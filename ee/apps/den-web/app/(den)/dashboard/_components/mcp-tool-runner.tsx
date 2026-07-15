"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Check, Loader2, LockKeyhole, Play, RefreshCw, Wrench } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenSelect } from "../../_components/ui/select";
import { DenTextarea } from "../../_components/ui/textarea";
import {
  type ExternalMcpConnection,
  type ExternalMcpInspectionBody,
  type ExternalMcpInspectionHeader,
  type ExternalMcpTool,
  type ExternalMcpToolCallInspection,
  ExternalMcpToolRunError,
  useMcpConnectionTools,
  useRunMcpConnectionTool,
} from "./mcp-connections-data";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function placeholderValue(definition: unknown): unknown {
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

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function InspectionHeaders({ headers }: { headers: ExternalMcpInspectionHeader[] }) {
  if (headers.length === 0) return <p className="text-[11px] text-gray-400">No headers captured.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      {headers.map((header, index) => (
        // Headers such as set-cookie can repeat, so the name alone is not a
        // stable React key.
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

function InspectionBody({ body }: { body: ExternalMcpInspectionBody }) {
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

function diagnosisLayerLabel(layer: ExternalMcpToolCallInspection["diagnosis"]["layer"]): string {
  if (layer === "openwork") return "OpenWork before send";
  if (layer === "network") return "Network / no response";
  if (layer === "mcp_connection") return "MCP connection / setup";
  if (layer === "remote_http") return "Remote MCP HTTP";
  return "MCP tool response";
}

function McpToolCallInspector({ inspection }: { inspection: ExternalMcpToolCallInspection }) {
  const succeeded = inspection.diagnosis.status === "succeeded";
  // A captured request can still have been blocked inside OpenWork (for
  // example by the outbound SSRF policy); the diagnosis layer decides
  // between "never sent" and "sent but unanswered".
  const transportChip = inspection.response
    ? `HTTP ${inspection.response.status}`
    : inspection.request && inspection.diagnosis.layer !== "openwork"
      ? "No response"
      : "Not sent";
  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white" aria-label="Tool call inspection">
      <div className={`border-b px-4 py-3 ${succeeded ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`text-[12px] font-semibold ${succeeded ? "text-emerald-800" : "text-red-800"}`}>
            {succeeded ? "Remote MCP completed the call" : `Call stopped at: ${diagnosisLayerLabel(inspection.diagnosis.layer)}`}
          </p>
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-gray-600">
            <span>OpenWork</span><ArrowRight className="h-3 w-3" aria-hidden="true" />
            <span>{transportChip}</span><ArrowRight className="h-3 w-3" aria-hidden="true" />
            <span>{succeeded ? "Tool result" : "Failure"}</span>
          </div>
        </div>
        <p className={`mt-1 text-[11px] leading-5 ${succeeded ? "text-emerald-700" : "text-red-700"}`}>{inspection.diagnosis.summary}</p>
      </div>

      <div className="border-b border-amber-100 bg-amber-50/70 px-4 py-2 text-[10px] leading-4 text-amber-800">
        Credential and session headers are redacted. Request and response bodies may contain sensitive provider data; this inspection is returned only for this run and is not stored in Den logs.
      </div>

      <div className="grid gap-0 xl:grid-cols-2 xl:divide-x xl:divide-gray-200">
        <div className="space-y-4 p-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Outgoing request</p>
            {inspection.request ? (
              <div className="mt-2 rounded-lg bg-gray-950 px-3 py-2 font-mono text-[10px] leading-4 text-gray-100">
                <span className="font-semibold text-blue-300">{inspection.request.method}</span> <span className="break-all">{inspection.request.url}</span>
              </div>
            ) : (
              <p className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">No tools/call request left OpenWork.</p>
            )}
          </div>
          {inspection.request ? (
            <>
              <div><p className="mb-1.5 text-[11px] font-medium text-gray-700">Headers</p><InspectionHeaders headers={inspection.request.headers} /></div>
              <InspectionBody body={inspection.request.body} />
            </>
          ) : null}
        </div>

        <div className="space-y-4 border-t border-gray-200 p-4 xl:border-t-0">
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
      </div>
    </section>
  );
}

export function McpToolRunner({ connection }: { connection: ExternalMcpConnection }) {
  const catalog = useMcpConnectionTools(connection.id, true);
  const runTool = useRunMcpConnectionTool(connection.id);
  const tools = useMemo(() => catalog.data ?? [], [catalog.data]);
  const [selectedToolName, setSelectedToolName] = useState("");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [localError, setLocalError] = useState<string | null>(null);
  const [destructiveConfirmed, setDestructiveConfirmed] = useState(false);
  const selectedTool = tools.find((tool) => tool.name === selectedToolName) ?? tools[0] ?? null;

  useEffect(() => {
    if (!tools.length || tools.some((tool) => tool.name === selectedToolName)) return;
    const firstTool = tools[0];
    if (!firstTool) return;
    setSelectedToolName(firstTool.name);
    setArgumentsText(formatJson(mcpToolArgumentTemplate(firstTool)));
    setDestructiveConfirmed(false);
  }, [selectedToolName, tools]);

  function selectTool(toolName: string) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) return;
    setSelectedToolName(tool.name);
    setArgumentsText(formatJson(mcpToolArgumentTemplate(tool)));
    setDestructiveConfirmed(false);
    setLocalError(null);
    runTool.reset();
  }

  async function handleRun() {
    if (!selectedTool) return;
    setLocalError(null);
    runTool.reset();

    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsText);
    } catch {
      setLocalError("Arguments must be valid JSON.");
      return;
    }
    if (!isRecord(parsed)) {
      setLocalError("Arguments must be a JSON object, such as {}.");
      return;
    }
    if (selectedTool.annotations?.destructiveHint && !destructiveConfirmed) {
      setLocalError("Confirm the destructive tool warning before running this tool.");
      return;
    }

    await runTool.mutateAsync({ toolName: selectedTool.name, arguments: parsed }).catch(() => undefined);
  }

  const executionError = localError
    ?? (runTool.error instanceof Error ? runTool.error.message : runTool.error ? "The MCP tool failed." : null);
  const inspection = runTool.data?.inspection
    ?? (runTool.error instanceof ExternalMcpToolRunError ? runTool.error.inspection : null);

  return (
    <div className="border-t border-gray-100 bg-gray-50/70 px-6 py-5" data-testid={`mcp-tool-runner-${connection.id}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-gray-500" />
            <p className="text-[13px] font-semibold text-gray-900">Run a tool manually</p>
          </div>
          <p className="mt-1 max-w-2xl text-[12px] leading-5 text-gray-500">
            This runs directly from Den with your available connection credential. Arguments and results are not written to Den logs.
          </p>
        </div>
        <DenButton variant="secondary" size="sm" loading={catalog.isFetching} onClick={() => void catalog.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh tools
        </DenButton>
      </div>

      {catalog.isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-[12px] text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading the MCP tool catalog…
        </div>
      ) : catalog.error ? (
        <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-5 text-red-700">
          {catalog.error instanceof Error ? catalog.error.message : "Could not read this MCP's tools."}
        </div>
      ) : tools.length === 0 ? (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-500">
          This MCP is connected but does not currently expose any tools.
        </div>
      ) : selectedTool ? (
        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-gray-700" htmlFor={`mcp-tool-${connection.id}`}>
              Tool
            </label>
            <DenSelect
              id={`mcp-tool-${connection.id}`}
              value={selectedTool.name}
              onChange={(event) => selectTool(event.target.value)}
              disabled={runTool.isPending}
            >
              {tools.map((tool) => (
                <option key={tool.name} value={tool.name}>{tool.title || tool.annotations?.title || tool.name}</option>
              ))}
            </DenSelect>
            <p className="mt-2 font-mono text-[11px] text-gray-500">{selectedTool.name}</p>
            {selectedTool.description ? <p className="mt-1 text-[12px] leading-5 text-gray-600">{selectedTool.description}</p> : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-gray-700" htmlFor={`mcp-tool-arguments-${connection.id}`}>
                Arguments (JSON)
              </label>
              <DenTextarea
                id={`mcp-tool-arguments-${connection.id}`}
                className="min-h-56 font-mono text-[12px] leading-5"
                rows={10}
                value={argumentsText}
                onChange={(event) => {
                  setArgumentsText(event.target.value);
                  setLocalError(null);
                  runTool.reset();
                }}
                disabled={runTool.isPending}
                spellCheck={false}
              />
            </div>
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-gray-700">Input schema</p>
              <pre className="max-h-56 overflow-auto rounded-xl bg-gray-950 p-3 text-[10px] leading-4 text-gray-100">{formatJson(selectedTool.inputSchema)}</pre>
            </div>
          </div>

          {selectedTool.annotations?.destructiveHint ? (
            <label className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] leading-5 text-red-700">
              <input
                type="checkbox"
                className="mt-1"
                checked={destructiveConfirmed}
                onChange={(event) => setDestructiveConfirmed(event.target.checked)}
              />
              <span><strong>Destructive tool warning.</strong> The provider says this tool may change or delete external data. I want to run it with these arguments.</span>
            </label>
          ) : selectedTool.annotations?.readOnlyHint ? (
            <p className="inline-flex items-center gap-1.5 text-[11px] font-medium text-blue-700">
              <Check className="h-3.5 w-3.5" /> Provider marks this tool as read-only.
            </p>
          ) : (
            <p className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" /> The provider did not mark this tool as read-only. Review the arguments before running it.
            </p>
          )}

          {executionError ? (
            <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-5 text-red-700" role="alert">
              {executionError}
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <DenButton
              variant="primary"
              size="sm"
              icon={Play}
              loading={runTool.isPending}
              onClick={() => void handleRun()}
            >
              Run tool
            </DenButton>
            <p className="text-[11px] text-gray-500">Runs immediately against {connection.name}.</p>
          </div>

          {inspection ? <McpToolCallInspector inspection={inspection} /> : null}

          {runTool.data && !runTool.data.inspection ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] leading-5 text-amber-800" role="status">
              The tool completed, but request and response details were unavailable. Refresh after the dashboard and its server are running the same version.
            </div>
          ) : null}

          {runTool.data ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4" role="status">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-emerald-800">
                  <Check className="h-4 w-4" /> Tool completed
                </p>
                <p className="font-mono text-[10px] text-emerald-700">
                  {runTool.data.referenceId} · {runTool.data.durationMs} ms
                </p>
              </div>
              <pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-gray-950 p-3 text-[10px] leading-4 text-gray-100">{formatJson(runTool.data.result)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
