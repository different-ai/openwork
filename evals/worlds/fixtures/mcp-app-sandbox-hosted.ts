import type { OpenworkMcpAppResource } from "../../../apps/app/src/app/lib/openwork-server";
import type { PreservedMcpAppResult } from "../../../apps/app/src/components/chat/mcp-app-frame";

export type HostedSandboxResource = {
  label: string;
  app: OpenworkMcpAppResource;
  inputArguments: Record<string, unknown>;
  result: PreservedMcpAppResult;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function demoArguments(tool: Record<string, unknown>): Record<string, unknown> | null {
  if (!record(tool.annotations) || tool.annotations.readOnlyHint !== true || tool.annotations.destructiveHint !== false || tool.annotations.openWorldHint !== false) return null;
  if (!record(tool.inputSchema) || !record(tool.inputSchema.properties) || tool.inputSchema.type !== "object") return null;
  const input = tool.inputSchema.properties;
  if (record(tool.outputSchema) && record(tool.outputSchema.properties) && record(tool.outputSchema.properties.demo)
    && tool.outputSchema.properties.demo.const === true && Object.keys(input).length === 0
    && (!Array.isArray(tool.inputSchema.required) || tool.inputSchema.required.length === 0)) return {};
  if (Object.keys(input).every((key) => ["cities", "limit", "hourCycle"].includes(key))
    && record(input.cities) && input.cities.type === "array" && record(input.cities.items) && input.cities.items.type === "string"
    && record(input.limit) && input.limit.type === "integer"
    && record(input.hourCycle) && Array.isArray(input.hourCycle.enum) && input.hourCycle.enum.includes("24h")
    && record(tool.outputSchema) && record(tool.outputSchema.properties) && record(tool.outputSchema.properties.source)
    && Array.isArray(tool.outputSchema.properties.source.enum) && tool.outputSchema.properties.source.enum.includes("input")) {
    return { cities: ["Etc/UTC"], limit: 1, hourCycle: "24h" };
  }
  return null;
}

function domains(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) throw new Error("Unsupported CSP");
  return value.map((entry) => {
    const url = new URL(entry);
    if (url.protocol !== "https:" || url.origin !== entry || url.username || url.password) throw new Error("Unsupported CSP origin");
    return entry;
  });
}

async function responseJson(response: Response): Promise<unknown[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error("Response exceeds fixture limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!text.trim()) return [];
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return text.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      return data ? [JSON.parse(data)] : [];
    });
  }
  return [JSON.parse(text)];
}

export async function acquireHostedSandboxResources(configuration: string): Promise<HostedSandboxResource[]> {
  let endpoints: unknown;
  try { endpoints = JSON.parse(configuration); } catch { throw new Error("Demo endpoints must be a JSON array"); }
  if (!Array.isArray(endpoints) || endpoints.length !== 3 || !endpoints.every((endpoint): endpoint is string => typeof endpoint === "string")) {
    throw new Error("Hosted matrix requires exactly three explicitly authorized demo endpoints");
  }
  const resources: HostedSandboxResource[] = [];
  for (const [index, endpoint] of endpoints.entries()) {
    const label = `provider-${index + 1}`;
    let phase = "endpoint-validation";
    let failureCode = "unsupported";
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid endpoint");
      let session: string | null = null;
      let sequence = 0;
      async function rpc(method: "initialize" | "notifications/initialized" | "tools/list" | "tools/call" | "resources/read", params: Record<string, unknown>) {
        phase = method;
        const id = ++sequence;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(method === "notifications/initialized" ? {} : { id }) }),
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
          credentials: "omit",
        });
        session = response.headers.get("mcp-session-id") ?? session;
        if (!response.ok) {
          failureCode = `HTTP_${response.status}`;
          await response.body?.cancel();
          throw new Error("Provider refused request");
        }
        const messages = await responseJson(response);
        if (method === "notifications/initialized") return {};
        const message = messages.find((entry) => record(entry) && entry.id === id);
        if (!record(message) || !record(message.result) || message.error) throw new Error("Unsupported protocol response");
        return message.result;
      }
      await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sandbox-demo-fixture", version: "1.0.0" } });
      await rpc("notifications/initialized", {});
      const listed = await rpc("tools/list", {});
      phase = "safe-demo-selection";
      if (!Array.isArray(listed.tools)) throw new Error("Tools unavailable");
      let selected: { name: string; uri: string; inputArguments: Record<string, unknown> } | undefined;
      for (const tool of listed.tools) {
        if (!record(tool) || typeof tool.name !== "string" || !record(tool._meta) || !record(tool._meta.ui)) continue;
        if (Array.isArray(tool._meta.ui.visibility) && !tool._meta.ui.visibility.includes("model")) continue;
        if (typeof tool._meta.ui.resourceUri !== "string" || !tool._meta.ui.resourceUri.startsWith("ui://")) continue;
        const inputArguments = demoArguments(tool);
        if (inputArguments) { selected = { name: tool.name, uri: tool._meta.ui.resourceUri, inputArguments }; break; }
      }
      if (!selected) throw new Error("No supported safe demo launch schema");
      const result = await rpc("tools/call", { name: selected.name, arguments: selected.inputArguments });
      phase = "demo-result-validation";
      if (result.isError || !Array.isArray(result.content) || !result.content.every(record) || !record(result.structuredContent)) throw new Error("Demo launch failed");
      if (Object.keys(selected.inputArguments).length === 0 ? result.structuredContent.demo !== true : result.structuredContent.source !== "input") throw new Error("Result is not explicit demo/input mode");
      const resource = await rpc("resources/read", { uri: selected.uri });
      phase = "resource-validation";
      if (!Array.isArray(resource.contents)) throw new Error("Resource unavailable");
      const content = resource.contents.find((entry) => record(entry) && entry.uri === selected.uri);
      if (!record(content) || typeof content.text !== "string" || content.mimeType !== "text/html;profile=mcp-app") throw new Error("Unsupported resource");
      const ui = record(content._meta) && record(content._meta.ui) ? content._meta.ui : {};
      if (record(ui.permissions) && Object.keys(ui.permissions).length > 0) throw new Error("Permissioned demo is unsupported");
      const policy = record(ui.csp) ? ui.csp : {};
      const csp = { connectDomains: domains(policy.connectDomains), resourceDomains: domains(policy.resourceDomains), frameDomains: domains(policy.frameDomains), baseUriDomains: domains(policy.baseUriDomains) };
      if (csp.connectDomains.length || csp.frameDomains.length || csp.baseUriDomains.length) throw new Error("Only static demo resources are supported");
      resources.push({
        label,
        app: { serverName: label, toolName: selected.name, resourceUri: selected.uri, html: content.text, csp, prefersBorder: ui.prefersBorder === true },
        inputArguments: selected.inputArguments,
        result: { content: result.content, structuredContent: result.structuredContent, ...(record(result._meta) ? { _meta: result._meta } : {}) },
      });
    } catch {
      throw new Error(`${label}: ${phase} failed (${failureCode}); no authentication or alternate mode attempted`);
    }
  }
  return resources;
}
