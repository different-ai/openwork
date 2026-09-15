import React from "react";
import { createRoot } from "react-dom/client";
import { McpAppSandboxView } from "../../../apps/app/src/components/chat/mcp-app-frame";
import { createOpenworkServerClient, type OpenworkMcpAppResource } from "../../../apps/app/src/app/lib/openwork-server";
import type { HostedSandboxResource } from "./mcp-app-sandbox-hosted";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHostedResource(value: unknown): value is HostedSandboxResource {
  if (!isRecord(value) || typeof value.label !== "string" || !/^provider-\d+$/.test(value.label)
    || !isRecord(value.app) || !isRecord(value.app.csp) || !isRecord(value.inputArguments) || !isRecord(value.result)) return false;
  const app = value.app;
  const csp = app.csp;
  return isRecord(csp) && ["serverName", "toolName", "resourceUri", "html"].every((key) => typeof app[key] === "string")
    && typeof app.prefersBorder === "boolean"
    && ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"].every((key) => Array.isArray(csp[key]) && csp[key].every((domain: unknown) => typeof domain === "string"))
    && Array.isArray(value.result.content) && value.result.content.every(isRecord)
    && (value.result.structuredContent === undefined || isRecord(value.result.structuredContent))
    && (value.result._meta === undefined || isRecord(value.result._meta))
    && (value.result.isError === undefined || typeof value.result.isError === "boolean");
}

const query = new URLSearchParams(location.search);
const proxyOrigin = query.get("proxy");
if (!proxyOrigin || new URL(proxyOrigin).hostname !== "127.0.0.1") throw new Error("Loopback proxy required");
const count = Number(query.get("tiles") ?? "1");
const hosted = query.get("hosted") === "true";
document.documentElement.dataset.hosted = String(hosted);
const payload: unknown = hosted ? await fetch("/fixture-hosted-resources", { signal: AbortSignal.timeout(10_000), cache: "no-store" }).then((response) => response.json()) : [];
if (!Array.isArray(payload) || !payload.every(isHostedResource) || (hosted && payload.length !== 3)) throw new Error("Invalid hosted fixture payload");
const hostedResources = payload;
const providerOffset = Number(query.get("providerOffset") ?? "0");
const hostedForTile = (tile: number) => hostedResources[(tile + providerOffset) % hostedResources.length];
const trace = document.createElement("script");
trace.type = "application/json";
trace.id = "sandbox-trace";
document.body.append(trace);
const events: Array<{ at: number; tile: string; kind: string; detail: unknown }> = [];
function record(tile: string, kind: string, detail: unknown = null) {
  const publicKinds = ["mount", "navigation-assigned", "view-error", "console.error", "runtime-error", "unhandled-rejection", "ui/initialize", "ui/notifications/initialized", "ui/notifications/sandbox-proxy-ready", "ui/notifications/sandbox-resource-accepted", "ui/notifications/sandbox-resource-loaded", "hosted-input-received", "hosted-result-received", "hosted-delivery-mismatch"];
  events.push({ at: performance.timeOrigin + performance.now(), tile, kind: hosted && !publicKinds.includes(kind) ? "other-message" : kind, detail: hosted ? null : detail });
  trace.textContent = JSON.stringify(events);
}
window.addEventListener("message", (event) => {
  const frame = Array.from(document.querySelectorAll("iframe")).find((candidate) => candidate.contentWindow === event.source);
  if (!frame || event.origin !== proxyOrigin) return;
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || !("method" in data) || typeof data.method !== "string") return;
  const tile = frame.closest("[data-tile]")?.getAttribute("data-tile") ?? "unknown";
  if (hosted && data.method === "fixture/hosted-received") {
    const expected = hostedForTile(Number(tile));
    const params = "params" in data && isRecord(data.params) ? data.params : null;
    if (!expected || !params || !isRecord(params.payload)) return;
    const kind = params.kind;
    const actual = kind === "input" ? params.payload.arguments : params.payload;
    const target = kind === "input" ? expected.inputArguments : expected.result;
    const matches = JSON.stringify(actual) === JSON.stringify(target);
    record(tile, matches ? kind === "input" ? "hosted-input-received" : "hosted-result-received" : "hosted-delivery-mismatch");
    return;
  }
  record(tile, data.method, "params" in data ? data.params : null);
});
const originalError = console.error;
console.error = (...args: unknown[]) => {
  record("host", "console.error", args);
  if (!hosted) originalError(...args);
};
window.addEventListener("error", (event) => record("host", "runtime-error", event.message));
window.addEventListener("unhandledrejection", (event) => record("host", "unhandled-rejection", String(event.reason)));
const client = createOpenworkServerClient({ baseUrl: proxyOrigin });
const origin = { client, workspaceId: "sandbox-startup-fixture", sessionId: null, readOnly: true };
document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  if (button?.textContent === "Retry") record(button.closest("[data-tile]")?.getAttribute("data-tile") ?? "unknown", "retry-click", { trusted: event.isTrusted });
}, true);
const tiles = Array.from({ length: count }, (_, index) => {
  const tile = String(index);
  const args = { tile, request: "fixture-launch" };
  const result = { content: [{ type: "text", text: `fixture-result-${tile}` }] };
  const app: OpenworkMcpAppResource = {
    serverName: "sandbox-startup-fixture",
    toolName: `fixture-${tile}`,
    resourceUri: `ui://sandbox-startup/${tile}`,
    prefersBorder: false,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    html: `<!doctype html><html><head><title>Protocol witness ${tile}</title></head><body><p id="result">Waiting</p><script>
      let launchArguments = null;
      const send = (method, params = {}) => parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
      addEventListener("message", (event) => {
        const data = event.data;
        if (data.id === 1 && data.result) send("ui/notifications/initialized");
        if (data.method === "ui/notifications/tool-input") launchArguments = data.params.arguments;
        if (data.method === "ui/notifications/tool-result") {
          document.getElementById("result").textContent = data.params.content[0].text;
          parent.postMessage({ method: "fixture/result-received", params: { text: document.getElementById("result").textContent, arguments: launchArguments } }, "*");
        }
        if (data.method === "ui/resource-teardown") parent.postMessage({ jsonrpc: "2.0", id: data.id, result: {} }, "*");
      });
      parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "Protocol witness", version: "1.0.0" }, appCapabilities: {} } }, "*");
    </script></body></html>`,
  };
  const source = hosted ? hostedForTile(index) : undefined;
  const resource = source?.app ?? app;
  return <section data-tile={tile} data-provider={source?.label} key={tile}>
    <McpAppSandboxView origin={origin} app={resource} toolName={resource.toolName} inputArguments={source?.inputArguments ?? args} result={source?.result ?? result}
      presentation="dashboard" unavailableNotice="Fixture interactive view unavailable."
      onError={() => record(tile, "view-error")} />
  </section>;
});
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
const navigations = new WeakMap<HTMLIFrameElement, string>();
new MutationObserver(() => {
  for (const frame of document.querySelectorAll("iframe")) {
    const src = frame.getAttribute("src");
    if (!src || navigations.get(frame) === src) continue;
    navigations.set(frame, src);
    record(frame.closest("[data-tile]")?.getAttribute("data-tile") ?? "unknown", "navigation-assigned");
  }
}).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
record("host", "mount", { tiles: count });
createRoot(root).render(<>{tiles}</>);
