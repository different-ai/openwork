"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Loader2, RefreshCw, Search, Wrench } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import {
  type ExternalMcpConnection,
  type ExternalMcpTool,
  isNativeProviderConnectionId,
  useMcpConnectionTools,
} from "./mcp-connections-data";

const MCP_TOOL_PAGE_SIZE = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function schemaInputs(schema: Record<string, unknown>): Array<{ name: string; required: boolean; type: string | null }> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  return Object.entries(properties).map(([name, definition]) => ({
    name,
    required: required.has(name),
    type: isRecord(definition) && typeof definition.type === "string" ? definition.type : null,
  }));
}

function toolHints(tool: ExternalMcpTool): Array<{ label: string; className: string }> {
  const annotations = tool.annotations;
  if (!annotations) return [];
  return [
    annotations.readOnlyHint ? { label: "Read-only hint", className: "bg-blue-50 text-blue-700" } : null,
    annotations.destructiveHint ? { label: "Destructive hint", className: "bg-red-50 text-red-700" } : null,
    annotations.idempotentHint ? { label: "Idempotent hint", className: "bg-emerald-50 text-emerald-700" } : null,
    annotations.openWorldHint ? { label: "External access hint", className: "bg-amber-50 text-amber-700" } : null,
  ].filter((hint): hint is { label: string; className: string } => hint !== null);
}

function availabilityBadge(tool: ExternalMcpTool): { label: string; className: string } | null {
  if (tool.availability === "connection_required") {
    return { label: "Connect account", className: "bg-gray-100 text-gray-600" };
  }
  if (tool.availability === "reconnect_required") {
    return { label: "Reconnect required", className: "bg-amber-50 text-amber-700" };
  }
  if (tool.availability === "available") {
    return { label: "Available", className: "bg-emerald-50 text-emerald-700" };
  }
  return null;
}

export function McpToolCatalog({ connection }: { connection: ExternalMcpConnection }) {
  const catalog = useMcpConnectionTools(connection.id, true);
  const [toolSearch, setToolSearch] = useState("");
  const [visibleToolLimit, setVisibleToolLimit] = useState(MCP_TOOL_PAGE_SIZE);
  const nativeProvider = isNativeProviderConnectionId(connection.id);
  const filteredTools = useMemo(() => {
    const needle = toolSearch.trim().toLowerCase();
    if (!needle) return catalog.data ?? [];
    return (catalog.data ?? []).filter((tool) =>
      [tool.name, tool.title, tool.annotations?.title, tool.description]
        .some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [catalog.data, toolSearch]);
  const visibleTools = filteredTools.slice(0, visibleToolLimit);
  const remainingToolCount = filteredTools.length - visibleTools.length;
  const availableToolCount = (catalog.data ?? []).filter((tool) => tool.availability === undefined || tool.availability === "available").length;

  return (
    <div
      className="border-t border-gray-100 bg-gray-50/70 px-6 py-5"
      data-mcp-tool-catalog={connection.id}
      data-testid={`mcp-tool-catalog-${connection.id}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-gray-500" />
            <p className="text-[13px] font-semibold text-gray-900">Tools available to your agents</p>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-gray-500">
            {nativeProvider
              ? `From OpenWork's registered ${connection.name} capabilities. Viewing this catalog does not run a tool.`
              : `Live from ${connection.name}. Inspecting this list does not run a tool. Provider annotations are hints, not guarantees.`}
          </p>
        </div>
        <DenButton variant="secondary" size="sm" loading={catalog.isFetching} onClick={() => void catalog.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </DenButton>
      </div>

      {catalog.data && catalog.data.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full sm:max-w-sm">
            <DenInput
              aria-label={nativeProvider ? "Search connection tools" : "Search MCP tools"}
              icon={Search}
              value={toolSearch}
              onChange={(event) => {
                setToolSearch(event.target.value);
                setVisibleToolLimit(MCP_TOOL_PAGE_SIZE);
              }}
              placeholder="Search tools by name or description"
            />
          </div>
          <p className="shrink-0 text-[11px] font-medium text-gray-500" role="status">
            {toolSearch.trim()
              ? `${filteredTools.length} of ${catalog.data.length} tools`
              : nativeProvider
                ? `${availableToolCount} of ${catalog.data.length} tools available now`
                : `${catalog.data.length} ${catalog.data.length === 1 ? "tool" : "tools"} exposed`}
          </p>
        </div>
      ) : null}

      {catalog.isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-[12px] text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          {nativeProvider ? "Reading the tool catalog…" : "Reading the MCP tool catalog…"}
        </div>
      ) : catalog.error ? (
        <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-5 text-red-700">
          {catalog.error instanceof Error
            ? catalog.error.message
            : nativeProvider
              ? "Could not read this connection's tools."
              : "Could not read this MCP's tools."}
        </div>
      ) : catalog.data?.length === 0 ? (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-500">
          {nativeProvider
            ? "This connection does not currently make any tools available."
            : "This MCP is connected but does not currently expose any tools."}
        </div>
      ) : filteredTools.length === 0 ? (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-500">
          No tools match “{toolSearch.trim()}”.
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {visibleTools.map((tool) => {
              const inputs = schemaInputs(tool.inputSchema);
              const hints = toolHints(tool);
              const availability = availabilityBadge(tool);
              const displayTitle = tool.title || tool.annotations?.title;
              return (
                <details key={tool.name} className="group rounded-2xl border border-gray-200 bg-white p-4">
                  <summary className="cursor-pointer list-none">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {displayTitle ? (
                          <>
                            <p className="break-words text-[12px] font-semibold text-gray-900">{displayTitle}</p>
                            <p className="mt-0.5 break-words font-mono text-[10px] text-gray-500">{tool.name}</p>
                          </>
                        ) : (
                          <p className="break-words font-mono text-[12px] font-semibold text-gray-900">{tool.name}</p>
                        )}
                        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-gray-500">
                          {tool.description || (nativeProvider ? "No description provided for this tool." : "No description provided by this MCP.")}
                        </p>
                      </div>
                      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 transition group-open:rotate-90" />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <p className="text-[11px] font-medium text-gray-500">
                        {inputs.length === 0 ? "No inputs" : `${inputs.length} ${inputs.length === 1 ? "input" : "inputs"}`}
                      </p>
                      {availability ? (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${availability.className}`}>
                          {availability.label}
                        </span>
                      ) : null}
                      {hints.map((hint) => (
                        <span
                          key={hint.label}
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${hint.className}`}
                          title={nativeProvider ? "Derived from the registered Den capability route." : "Provider-supplied MCP annotation; treat as a hint."}
                        >
                          {hint.label}
                        </span>
                      ))}
                    </div>
                  </summary>
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    {tool.availabilityReason ? (
                      <p className="mb-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                        {tool.availabilityReason}
                      </p>
                    ) : null}
                    {inputs.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {inputs.map((input) => (
                          <span key={input.name} className="rounded-full bg-gray-100 px-2.5 py-1 font-mono text-[11px] text-gray-700">
                            {input.name}{input.type ? `: ${input.type}` : ""}{input.required ? " · required" : ""}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <details className="mt-3">
                      <summary className="cursor-pointer text-[11px] font-medium text-gray-500">View input schema</summary>
                      <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-gray-950 p-3 text-[10px] leading-4 text-gray-100">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                    </details>
                    {tool.outputSchema ? (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-[11px] font-medium text-gray-500">View output schema</summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-gray-950 p-3 text-[10px] leading-4 text-gray-100">{JSON.stringify(tool.outputSchema, null, 2)}</pre>
                      </details>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
          {remainingToolCount > 0 ? (
            <div className="mt-4 flex justify-center">
              <DenButton
                variant="secondary"
                size="sm"
                onClick={() => setVisibleToolLimit((current) => current + MCP_TOOL_PAGE_SIZE)}
              >
                Show {Math.min(MCP_TOOL_PAGE_SIZE, remainingToolCount)} more
              </DenButton>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
