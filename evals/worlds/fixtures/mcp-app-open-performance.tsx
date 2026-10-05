import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createOpenworkServerClient, type OpenworkMcpAppResource } from "../../../apps/app/src/app/lib/openwork-server";
import { McpAppFrame } from "../../../apps/app/src/components/chat/mcp-app-frame";
import { setDenBootstrapConfig, writeDenSettings } from "../../../apps/app/src/app/lib/den";
import { McpAppTile } from "../../../apps/app/src/react-app/domains/dashboard/mcp-app-tile";
import type { DashboardMcpAppEntry } from "../../../apps/app/src/react-app/domains/dashboard/dashboard-mcp-app-entry";

type Configuration = {
  baseUrl: string; directBaseUrl: string; token: string; workspaceId: string; sessionId: string;
  disablePresentationCache: boolean;
  apps: Array<{ appId: string; title: string; serverName: string; toolName: string; resourceUri: string }>;
};
// Only this loopback, test-owned page receives synthetic runtime credentials.
const config: Configuration = await (await fetch("/fixture-config")).json();
const client = createOpenworkServerClient({ baseUrl: `${location.origin}${config.baseUrl}`, token: config.token });
client.mcpAppSandbox = createOpenworkServerClient({ baseUrl: config.directBaseUrl, token: config.token }).mcpAppSandbox;
export function benchmarkWorkspace() { return { openworkServerClient: client, workspaceId: config.workspaceId }; }
const origin = { client, workspaceId: config.workspaceId, sessionId: config.sessionId, readOnly: false };
await setDenBootstrapConfig({ baseUrl: config.directBaseUrl, apiBaseUrl: config.directBaseUrl });
writeDenSettings({ baseUrl: config.directBaseUrl, apiBaseUrl: config.directBaseUrl,
  activeOrgId: "synthetic-performance-org", authToken: config.disablePresentationCache ? null : "synthetic-performance-principal" }, { persistBootstrap: true });
export function benchmarkChatContext() { return { mcpAppOrigin: origin, uiStateOwner: "synthetic-performance-principal", readOnly: false }; }
let start = 0;
let first = true;
let errors = 0;
const errorObserver = new MutationObserver(() => {
  if (document.querySelector('[role="alert"], [data-mcp-app-diagnostic]')) {
    errors++;
    document.documentElement.dataset.appObservedErrorCount = String(errors);
  }
  if (first && performance.getEntriesByName("openwork.mcp-app.first-paint").length) ready();
});
errorObserver.observe(document.body, { childList: true, subtree: true });
new PerformanceObserver(list => {
  if (first && list.getEntries().some(entry => entry.name === "openwork.mcp-app.first-paint")) ready();
}).observe({ entryTypes: ["measure"] });
function ready() {
  if (!first) return;
  first = false;
  const sample = { paintMs: performance.now() - start, errors, stages: performance.getEntriesByType("measure")
    .filter(entry => entry.name.startsWith("openwork.mcp-app.")).map(entry => ({ stage: entry.name, durationMs: entry.duration })) };
  document.getElementById("measurement")!.textContent = JSON.stringify(sample);
}

function Chat({ index }: { index: number }) {
  const definition = config.apps[index];
  return <McpAppFrame part={{ type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: definition.appId,
    state: "output-available", input: {}, output: {}, callProviderMetadata: { openwork: { mcpResult: {
      content: [], structuredContent: { input: {} }, _meta: { "openwork/mcpApp": {
        connectionId: definition.appId, toolName: definition.toolName, resourceUri: definition.resourceUri, arguments: {},
      } },
    } } } }} />;
}

function Fixture() {
  const [current, setCurrent] = useState<{ surface: string; index: number; nonce: number } | null>(null);
  const open = (surface: string, index: number) => {
    start = performance.now(); document.documentElement.dataset.appOpenStartedAt = String(performance.timeOrigin + start); first = true; errors = 0;
    document.documentElement.dataset.appObservedErrorCount = "0"; performance.clearMeasures();
    document.getElementById("measurement")!.textContent = "";
    setCurrent(value => ({ surface, index, nonce: (value?.nonce ?? 0) + 1 }));
  };
  const definition = current ? config.apps[current.index] : null;
  const entry: DashboardMcpAppEntry | null = definition ? {
    kind: "mcp", id: definition.appId, title: definition.title, connectionId: definition.appId,
    serverName: definition.serverName, toolName: definition.toolName,
    projectedToolName: "openwork-cloud_execute_capability", resourceUri: definition.resourceUri,
    autoLaunch: true, launchArguments: {},
  } : null;
  return <main>
    <button onClick={() => { setCurrent(null); document.getElementById("measurement")!.textContent = ""; }}>Close App</button>
    {config.apps.map((app, index) => <button key={app.appId} onClick={() => open(index < 5 ? "chat" : "dashboard", index)}>Open {index}</button>)}
    <pre id="measurement" data-testid="measurement" />
    {current && (current.surface === "chat" ? <Chat key={current.nonce} index={current.index} />
      : entry && <McpAppTile key={current.nonce} entry={entry} cacheScopeKey="performance.synthetic.owner" />)}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
