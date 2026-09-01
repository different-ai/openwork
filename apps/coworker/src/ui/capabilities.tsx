import { useCallback, useEffect, useMemo, useState } from "react";

import type { CoworkerSummary, RuntimeInfo } from "@/lib/bridge";
import {
  createCoworkerMcpClient,
  type CoworkerMcpAppCatalogApp,
  type CoworkerMcpAppCatalogServer,
  type CoworkerMcpAppResource,
  type CoworkerMcpItem,
  type PreservedMcpAppResult,
} from "@/lib/mcp";
import { Button, Empty, ErrorNote, StatusDot, inputClass } from "@/ui/kit";
import { InlineLoader } from "@/ui/brand";
import { McpAppFrame } from "@/ui/mcp-app-frame";

type SelectedApp = {
  catalog: CoworkerMcpAppCatalogApp;
  server: CoworkerMcpAppCatalogServer;
};

function displayName(server: CoworkerMcpAppCatalogServer): string {
  return server.displayName?.trim() || server.serverName;
}

function initials(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "AP";
}

function configured(item: CoworkerMcpItem): boolean {
  return item.config.enabled !== false && item.disabledByTools !== true;
}

function inventoryLabel(item: CoworkerMcpItem): string {
  if (item.managedOAuth?.status === "needs_auth" || item.managedOAuth?.status === "reconnect_required") return "Connect account";
  if (item.managedOAuth?.status === "connecting") return "Connecting";
  return configured(item) ? "Available" : "Off";
}

function inventoryStatus(item: CoworkerMcpItem, server: CoworkerMcpAppCatalogServer | undefined): {
  label: string;
  tone: "mint" | "mist" | "rose";
} {
  const label = inventoryLabel(item);
  if (!configured(item)) return { label, tone: "mist" };
  if (server && !server.reachable) return { label: "Unavailable", tone: "rose" };
  if (label === "Connect account") return { label, tone: "rose" };
  if (label === "Connecting") return { label, tone: "mist" };
  return { label, tone: "mint" };
}

function isConnectGateway(item: CoworkerMcpItem): boolean {
  const name = item.name.toLowerCase();
  return name.includes("openwork-cloud") || name.includes("openwork_cloud") || name.includes("connect");
}

function appFailureMessage(result: PreservedMcpAppResult): string {
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string" || !item.text.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const message = Object.fromEntries(Object.entries(parsed)).message;
        if (typeof message === "string" && message.trim()) return message;
      }
    } catch {
      // Plain-text provider errors are already suitable for the compact UI.
    }
    return item.text;
  }
  return "This App could not start with the supplied input.";
}

export function CapabilitiesPanel({
  runtime,
  coworker,
  onAssign,
}: {
  runtime: RuntimeInfo;
  coworker: CoworkerSummary;
  onAssign: (prompt: string) => void;
}) {
  const client = useMemo(
    () => coworker.workspaceId
      ? createCoworkerMcpClient({
          serverUrl: runtime.serverUrl,
          workspaceId: coworker.workspaceId,
          token: runtime.ownerToken,
        })
      : null,
    [coworker.workspaceId, runtime.ownerToken, runtime.serverUrl],
  );
  const [inventory, setInventory] = useState<CoworkerMcpItem[]>([]);
  const [servers, setServers] = useState<CoworkerMcpAppCatalogServer[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<SelectedApp | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError("");
    try {
      const [nextInventory, nextApps] = await Promise.all([client.listInventory(), client.listApps()]);
      setInventory(nextInventory.items);
      setServers(nextApps.servers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apps = useMemo(() => servers.flatMap((server) => server.apps.map((catalog) => ({ server, catalog }))), [servers]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredApps = apps.filter(({ server, catalog }) => !normalizedQuery || [
    displayName(server),
    catalog.title,
    catalog.description,
    catalog.toolName,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery)));
  const filteredInventory = inventory.filter((item) => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery));
  const onlineServers = servers.filter((server) => server.reachable).length;
  const connectGateway = inventory.find(isConnectGateway);

  if (selected && client) {
    return (
      <AppDetail
        client={client}
        coworker={coworker}
        selected={selected}
        onBack={() => setSelected(null)}
        onAssign={onAssign}
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="coworker-capabilities">
      <div className="flex items-center gap-2">
        <input
          aria-label="Search Apps and tools"
          className={`${inputClass} h-9 bg-panel/60 text-xs`}
          placeholder="Search Apps and tools"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button aria-busy={loading} variant="ghost" className="h-9 text-xs" disabled={loading} onClick={() => void refresh()}>
          {loading ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      <section className="rounded-2xl border border-line bg-ink p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">OpenWork Connect</p>
            <h3 className="mt-2 text-sm font-semibold text-snow">Search first. Use the right capability.</h3>
          </div>
          <span className="shrink-0 rounded-full border border-line px-2 py-1 text-[9px] font-medium text-mist">
            search → execute
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-mist">
          {connectGateway && configured(connectGateway)
            ? `${coworker.name} can search your connected services, select a match, then execute it through OpenWork.`
            : "Connect OpenWork to search organization Apps and execute selected actions with the same controls as Desktop."}
        </p>
        <Button
          variant="primary"
          className="mt-3 w-full text-xs"
          onClick={() => onAssign(
            `Search my connected OpenWork capabilities for "${query.trim() || "what I need next"}". Use search_capabilities first, then execute_capability only after choosing the best match. Tell me what you selected and the result.`,
          )}
        >
          Ask {coworker.name}
        </Button>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Interactive Apps</h3>
          <span className="text-[10px] text-mist">{apps.length} · {onlineServers} sources online</span>
        </div>
        {filteredApps.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {filteredApps.map(({ server, catalog }) => (
              <button
                key={`${catalog.serverName}:${catalog.toolName}:${catalog.resourceUri}`}
                className="min-h-32 rounded-2xl border border-line bg-ink p-3 text-left transition-colors hover:border-white/15 hover:bg-panel"
                onClick={() => setSelected({ server, catalog })}
                data-testid="coworker-mcp-app"
              >
                <span className="flex size-9 items-center justify-center rounded-xl border border-line bg-panel text-[11px] font-semibold text-snow">
                  {initials(catalog.title || displayName(server))}
                </span>
                <span className="mt-3 block truncate text-xs font-semibold text-snow">{catalog.title || catalog.toolName}</span>
                <span className="mt-1 line-clamp-2 block text-[10px] leading-relaxed text-mist">
                  {catalog.description || displayName(server)}
                </span>
                <span className="mt-2 flex items-center gap-1.5 text-[9px] text-mist">
                  <StatusDot tone={server.reachable ? "mint" : "rose"} />
                  {displayName(server)}
                </span>
              </button>
            ))}
          </div>
        ) : loading ? (
          <Empty><InlineLoader label="Reading the live App catalog" /></Empty>
        ) : (
          <Empty>{normalizedQuery ? "No interactive Apps match this search." : "No MCP Apps are advertising an interactive view yet."}</Empty>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">MCP connections</h3>
          <span className="text-[10px] text-mist">{inventory.length}</span>
        </div>
        <div className="overflow-hidden rounded-2xl border border-line bg-ink">
          {filteredInventory.map((item, index) => {
            const status = inventoryStatus(item, servers.find((server) => server.serverName === item.name));
            return (
              <div
                key={`${item.source}:${item.name}`}
                className={`flex items-center gap-3 px-3 py-3 ${index > 0 ? "border-t border-line" : ""}`}
                data-testid="coworker-mcp-connection"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-panel text-[9px] font-semibold text-snow">
                  {initials(item.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-snow">{item.name}</span>
                  <span className="mt-0.5 block text-[9px] text-mist">
                    {isConnectGateway(item) ? "Search and execute across connected Apps" : item.source.replace("config.", "")}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[9px] text-mist">
                  <StatusDot tone={status.tone} />
                  {status.label}
                </span>
              </div>
            );
          })}
          {filteredInventory.length === 0 ? <Empty>{normalizedQuery ? "No MCP connection matches this search." : "No MCP connections configured."}</Empty> : null}
        </div>
      </section>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <p className="px-1 text-[9px] leading-relaxed text-mist/70">
        Catalog, permissions, connection state, and App resources are read live from this coworker’s OpenWork workspace.
      </p>
    </div>
  );
}

function AppDetail({
  client,
  coworker,
  selected,
  onBack,
  onAssign,
}: {
  client: ReturnType<typeof createCoworkerMcpClient>;
  coworker: CoworkerSummary;
  selected: SelectedApp;
  onBack: () => void;
  onAssign: (prompt: string) => void;
}) {
  const { catalog, server } = selected;
  const [inputText, setInputText] = useState(catalog.requiresInput ? "{\n  \n}" : "{}");
  const [approvalArmed, setApprovalArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resource, setResource] = useState<CoworkerMcpAppResource | null>(null);
  const [result, setResult] = useState<PreservedMcpAppResult | null>(null);
  const [argumentsValue, setArgumentsValue] = useState<Record<string, unknown>>({});

  async function open(approved: boolean) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputText);
    } catch {
      setError("Arguments must be a JSON object.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("Arguments must be a JSON object.");
      return;
    }
    const args = Object.fromEntries(Object.entries(parsed));
    setBusy(true);
    setError("");
    setResource(null);
    setResult(null);
    try {
      const launch = {
        ...(catalog.connectionId ? { connectionId: catalog.connectionId } : {}),
        toolName: catalog.toolName,
        resourceUri: catalog.resourceUri,
        arguments: args,
      };
      const resolved = await client.resolveApp(catalog.projectedToolName, launch);
      if (!resolved.app) throw new Error("This App no longer advertises an interactive view.");
      const called = await client.callAppTool({
        serverName: resolved.app.serverName,
        name: resolved.app.toolName,
        resourceUri: resolved.app.resourceUri,
        arguments: args,
        ...(approved ? { approved: true } : {}),
      });
      if (called.isError) throw new Error(appFailureMessage(called));
      setArgumentsValue(args);
      setResource(resolved.app);
      setResult(called);
      setApprovalArmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="coworker-mcp-app-detail">
      <button className="text-xs font-medium text-mist hover:text-snow" onClick={onBack}>← All Apps</button>
      <section className="rounded-2xl border border-line bg-ink p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-panel text-[11px] font-semibold text-snow">
            {initials(catalog.title || displayName(server))}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-snow">{catalog.title || catalog.toolName}</span>
            <span className="mt-0.5 block text-[10px] text-mist">{displayName(server)}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[9px] text-mist">
            <StatusDot tone={server.reachable ? "mint" : "rose"} />
            {server.reachable ? "Ready" : "Offline"}
          </span>
        </div>
        {catalog.description ? <p className="mt-3 text-xs leading-relaxed text-mist">{catalog.description}</p> : null}
        <div className="mt-3 flex flex-wrap gap-1.5 text-[9px] text-mist">
          <span className="rounded-full border border-line px-2 py-1">MCP App</span>
          {catalog.requiresInput ? <span className="rounded-full border border-line px-2 py-1">Accepts input</span> : null}
          {catalog.requiresApproval ? <span className="rounded-full border border-line px-2 py-1">Approval required</span> : <span className="rounded-full border border-line px-2 py-1">Read only</span>}
        </div>
      </section>

      {!resource ? (
        <section className="rounded-2xl border border-line bg-ink p-4">
          {catalog.requiresInput ? (
            <label className="block">
              <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Arguments · JSON</span>
              <textarea
                className={`${inputClass} min-h-28 resize-y bg-panel font-mono text-[11px]`}
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                spellCheck={false}
              />
            </label>
          ) : null}
          {catalog.requiresApproval && approvalArmed ? (
            <div className="mt-3 rounded-xl border border-amber/30 bg-amber/5 p-3">
              <p className="text-xs font-medium text-snow">Allow one call to {catalog.toolName}?</p>
              <p className="mt-1 text-[10px] leading-relaxed text-mist">OpenWork will execute it once with the arguments above.</p>
              <div className="mt-3 flex gap-2">
                <Button aria-busy={busy} variant="primary" className="flex-1 text-xs" disabled={busy} onClick={() => void open(true)}>
                  {busy ? "Opening…" : "Allow once"}
                </Button>
                <Button variant="ghost" className="text-xs" onClick={() => setApprovalArmed(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button
              aria-busy={busy}
              variant="primary"
              className={`${catalog.requiresInput ? "mt-3" : ""} w-full text-xs`}
              disabled={busy || !server.reachable}
              onClick={() => catalog.requiresApproval ? setApprovalArmed(true) : void open(false)}
            >
              {busy ? "Opening…" : catalog.requiresApproval ? "Review and open" : "Open App"}
            </Button>
          )}
        </section>
      ) : null}

      {resource && result ? (
        <McpAppFrame
          client={client}
          app={resource}
          toolName={catalog.projectedToolName}
          input={argumentsValue}
          result={result}
          onClose={() => {
            setResource(null);
            setResult(null);
          }}
        />
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <button
        className="w-full rounded-xl px-3 py-2 text-xs font-medium text-mist transition-colors hover:bg-panel hover:text-snow"
        onClick={() => onAssign(
          `Use the ${catalog.title || catalog.toolName} capability from ${displayName(server)} for this task. Search connected capabilities first when needed, then execute the selected capability and summarize the result.`,
        )}
      >
        Use with {coworker.name}
      </button>
    </div>
  );
}
