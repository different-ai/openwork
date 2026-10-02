import { AppBridge, PostMessageTransport } from "../../apps/app/node_modules/@modelcontextprotocol/ext-apps/dist/src/app-bridge.js";
import { CallToolResultSchema, ListToolsResultSchema, ReadResourceResultSchema } from "../../apps/app/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid MCP response");
  return value;
}

const picker = document.querySelector("select");
const open = document.querySelector("button");
const status = document.getElementById("status");
const error = document.getElementById("error");
const view = document.getElementById("view");
const argumentsInput = document.querySelector("textarea");
const bounds = document.getElementById("bounds");
if (!picker || !open || !status || !error || !view || !argumentsInput || !bounds) throw new Error("Reference host controls missing");
const controls = { picker, open, status, error, view, argumentsInput, bounds };
let requestId = 0;
let bridge: AppBridge | undefined;

async function rpc(method: string, params: Record<string, unknown>) {
  const response = await fetch(new URL("rpc", location.href), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`MCP proxy returned HTTP ${response.status}`);
  const message = record(await response.json());
  if (message.error) throw new Error(String(record(message.error).message));
  return message.result;
}

function fail(cause: unknown) {
  controls.error.hidden = false;
  controls.error.textContent = cause instanceof Error ? cause.message : "The app could not be opened";
  controls.status.textContent = "Couldn’t verify";
}

async function discover() {
  const listed = ListToolsResultSchema.parse(await rpc("tools/list", {}));
  const apps = listed.tools.flatMap(tool => {
    const ui = tool._meta?.ui;
    if (!ui || typeof ui !== "object" || !("resourceUri" in ui) || typeof ui.resourceUri !== "string") return [];
    return [{ tool, uri: ui.resourceUri }];
  });
  const requested = new URL(location.href).searchParams.get("tool");
  const selectable = requested ? apps.filter(({ tool }) => tool.name === requested) : apps;
  for (const { tool } of selectable) {
    const option = document.createElement("option");
    option.value = tool.name;
    option.textContent = tool.title ?? tool.name;
    controls.picker.append(option);
  }
  controls.open.disabled = selectable.length === 0;
  controls.status.textContent = selectable.length ? "Ready" : "App unavailable";
  controls.open.addEventListener("click", () => {
    void (async () => {
      controls.open.disabled = true;
      const selected = apps.find(({ tool }) => tool.name === controls.picker.value);
      if (!selected) throw new Error("Choose an advertised app");
      await bridge?.close();
      const args = record(JSON.parse(controls.argumentsInput.value));
      const result = CallToolResultSchema.parse(await rpc("tools/call", { name: selected.tool.name, arguments: args }));
      if (result.isError) throw new Error("The app is unavailable to this member");
      const resource = ReadResourceResultSchema.parse(await rpc("resources/read", { uri: selected.uri }));
      const content = resource.contents.find(item => item.uri === selected.uri && item.mimeType === "text/html;profile=mcp-app");
      if (!content || !("text" in content) || typeof content.text !== "string") throw new Error("The advertised app resource has no HTML");
      const bytes = new TextEncoder().encode(content.text);
      controls.view.dataset.resourceDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      controls.view.dataset.resourceUri = selected.uri;
      const frame = document.createElement("iframe");
      frame.title = selected.tool.title ?? selected.tool.name;
      frame.setAttribute("sandbox", "allow-scripts");
      controls.view.replaceChildren(frame);
      if (!frame.contentWindow) throw new Error("App window missing");
      const connected = new AppBridge(null, { name: "Reference host", version: "1.0.0" }, location.pathname === "/blocked/" ? {} : { serverTools: {} }, {
        hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"], platform: "web" },
      });
      bridge = connected;
      connected.oncalltool = async params => CallToolResultSchema.parse(await rpc("tools/call", params));
      connected.onerror = fail;
      const sizes: Array<{ height: number; applied: number; keys: string[] }> = [];
      controls.view.dataset.sizeEvents = "[]";
      connected.addEventListener("sizechange", (params) => {
        const { height } = params;
        if (typeof height !== "number" || !Number.isFinite(height) || height < 0) return;
        const applied = Math.max(160, Math.min(720, Math.ceil(height)));
        sizes.push({ height, applied, keys: Object.keys(params).sort() });
        frame.style.height = `${applied}px`;
        controls.view.dataset.sizeEvents = JSON.stringify(sizes);
        controls.bounds.textContent = `Requested ${Math.ceil(height)} px; frame ${applied} px; bounds 160–720 px`;
      });
      connected.oninitialized = () => {
        void (async () => {
          await connected.sendToolInput({ arguments: args });
          await connected.sendToolResult(result);
          controls.status.textContent = "App connected";
          controls.open.disabled = false;
        })().catch(fail);
      };
      await connected.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
      frame.srcdoc = content.text;
    })().catch(fail);
  });
}

void discover().catch(fail);
