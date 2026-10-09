import { randomBytes } from "node:crypto";
import { z } from "zod";
import { serve } from "./serve-node.js";
import { OpenWorkExtensionsPreview } from "./opencode-plugins/openwork-extensions-preview.js";
import { openworkReadTransport, type OpenworkReadTransport } from "./opencode-plugins/openwork-read-transport.js";
import { createV2ReadAdapter, readV2SessionActivity } from "./opencode-v2-read-adapter.js";
import { isRecord } from "./workspace-kv-store.js";
import { createV2BrowserBridge } from "./opencode-v2-browser-bridge.js";
import { OPENWORK_CLOUD_UPLOADS_EXTENSION_ID } from "./extensions/cloud-uploads.js";

const requestSchema = z.object({ name: z.enum(["openwork_context", "openwork_query", "openwork_skills", "openwork_drive_upload"]), input: z.unknown() });
const driveUploadSchema = z.object({ path: z.string().min(1), folderId: z.string().optional(), connectionId: z.string().optional() }).strict();
// Advertise only reads this bridge executes. Native MCP discovery owns remote
// tool names; v1 executor spellings and unregistered commands do not belong here.
function readAffordances(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readAffordances);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    key === "affordances" || key === "availableAffordances"
      ? Array.isArray(entry) ? entry.filter(item => isRecord(item) && item.kind === "query"
        && (!isRecord(item.executor) || item.executor.kind === "openwork")) : entry
      : readAffordances(entry)]));
}

/** Process-local app-read and browser endpoints, closed with their engine.
 * Build this host entry as one bundle: packaged desktops relocate engine plugin
 * files, and the shared factory and its request-local transport must use the
 * same AsyncLocalStorage instance rather than separately bundled copies. */
export async function createV2ContextBridge(hostRequest: (path: string, init?: RequestInit) => Promise<unknown>) {
  const token = randomBytes(32).toString("base64url");
  const plugin = await OpenWorkExtensionsPreview();
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/read") return new Response(null, { status: 404 });
    try {
      const text = await request.text();
      if (text.length > 64_000) return new Response(null, { status: 413 });
      const call = requestSchema.parse(JSON.parse(text));
      // Uploads share the host extension call's own transfer budget.
      const deadline = AbortSignal.timeout(call.name === "openwork_drive_upload" ? 130_000 : 60_000);
      const read = (path: string, init?: RequestInit) => {
        const signal = AbortSignal.any([request.signal, deadline, ...(init?.signal ? [init.signal] : [])]);
        signal.throwIfAborted();
        return hostRequest(path, { ...init, signal });
      };
      // Internal plugin discovery only: not a model-visible tool. This read
      // runs in the background and never participates in prompt admission.
      if (call.name === "openwork_skills") {
        return Response.json(await read("/experimental/connect/skills"));
      }
      // The one host write v2 receives: the same authorized-root file transport
      // v1 reaches through extension.call, never arbitrary extension actions.
      if (call.name === "openwork_drive_upload") {
        return Response.json(await read("/experimental/extensions/call", { method: "POST", body: JSON.stringify({
          extensionId: OPENWORK_CLOUD_UPLOADS_EXTENSION_ID, action: "drive_upload_file", args: driveUploadSchema.parse(call.input), context: {},
        }) }));
      }
      const transport: OpenworkReadTransport = {
        engine: "v2",
        activity: (workspaceId: string, sessionId: string) => readV2SessionActivity(path => read(path), workspaceId, sessionId),
        get: createV2ReadAdapter(path => read(path)),
        // v1 still serves sessions created there (e.g. by headless callers)
        // after the one-shot history import. Plain GETs through the host's v1
        // mount keep its workspace ownership checks.
        other: { engine: "v1", get: path => read(path) },
        post: async (path: string, body: Record<string, unknown>, signal?: AbortSignal) => {
          if (path !== "/experimental/ui-control/request" || !["context", "query"].includes(String(body.kind))) {
            throw new Error("Only OpenWork reads are available");
          }
          return read(path, { method: "POST", body: JSON.stringify(body), signal });
        },
      };
      const result = await openworkReadTransport.run(transport, async () => {
        if (call.name === "openwork_query") return plugin.tool.openwork_query.execute(call.input);
        const context: unknown = JSON.parse(await plugin.tool.openwork_context.execute());
        const filtered = readAffordances(context);
        return JSON.stringify(isRecord(filtered) ? { ...filtered, instructions: {
          context: "Use openwork_query for the discovered read-only affordances. For other conversations, use session.search then session.read. Session reads include current activity and background-agent counts."
        } } : filtered);
      });
      return new Response(result, { headers: { "Content-Type": "application/json" } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "OpenWork read failed" }, { status: 400 });
    }
  } });
  const browser = await createV2BrowserBridge().catch(async error => { await server.stop(); await plugin.dispose(); throw error; });
  return { url: `http://127.0.0.1:${server.port}/read`, token, browser: { url: browser.url, token: browser.token },
    close: async () => { await browser.close(); await server.stop(); await plugin.dispose(); } };
}
