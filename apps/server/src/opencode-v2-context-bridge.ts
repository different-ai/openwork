import { randomBytes } from "node:crypto";
import { z } from "zod";
import { serve } from "./serve-node.js";
import { OpenWorkExtensionsPreview } from "./opencode-plugins/openwork-extensions-preview.js";
import { openworkReadTransport, type OpenworkReadTransport } from "./opencode-plugins/openwork-read-transport.js";
import { createV2ReadAdapter, readV2SessionActivity } from "./opencode-v2-read-adapter.js";
import { isRecord } from "./workspace-kv-store.js";
import { createV2BrowserBridge } from "./opencode-v2-browser-bridge.js";
import { cloudSkillSnapshotSchema, loadableCloudSkillSnapshots, sameCloudSkillSnapshot } from "./opencode-plugins/openwork-cloud-skills-v2.js";

const requestSchema = z.object({ name: z.enum(["openwork_context", "openwork_query", "openwork_skills", "openwork_skill_read", "openwork_skill_authorize"]), input: z.unknown() });
const skillAuthorizationSchema = z.object({
  sessionID: z.string().regex(/^ses_[a-zA-Z0-9]+$/).max(128),
  skills: z.array(cloudSkillSnapshotSchema).min(1).max(150),
}).strict();
// Advertise only reads this bridge executes. The internal Cloud-attachment
// authorization operation is not a model tool or a generic command executor.
// Native MCP discovery owns remote tool names.
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
export async function createV2ContextBridge(
  hostRequest: (path: string, init?: RequestInit) => Promise<unknown>,
  authorizeSkillAttachment?: (sessionID: string, ids: string[]) => Promise<unknown>,
) {
  const token = randomBytes(32).toString("base64url");
  const plugin = await OpenWorkExtensionsPreview();
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/read") return new Response(null, { status: 404 });
    try {
      const text = await request.text();
      if (text.length > 64_000) return new Response(null, { status: 413 });
      const call = requestSchema.parse(JSON.parse(text));
      const deadline = AbortSignal.timeout(60_000);
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
      // This capability can only evaluate Cloud skill attachments; it cannot
      // grant permission, reply to a request, or invoke arbitrary host APIs.
      // Den's existing default-off nativeCloudSkills rollout owns this path.
      if (call.name === "openwork_skill_authorize") {
        const input = skillAuthorizationSchema.parse(call.input);
        const current = async () => {
          const listed = loadableCloudSkillSnapshots(await read("/experimental/connect/skills?fresh=true"));
          return listed !== undefined && input.skills.every(expected => {
            const matches = listed.filter(skill => skill.id === expected.id);
            return matches.length === 1 && sameCloudSkillSnapshot(matches[0], expected);
          });
        };
        if (!authorizeSkillAttachment || !await current()) return new Response(null, { status: 403 });
        const permission = z.object({ data: z.object({ effect: z.enum(["allow", "ask", "deny"]) }).passthrough() })
          .parse(await authorizeSkillAttachment(input.sessionID, input.skills.map(skill => skill.id)));
        // Permission hooks may await work while another location refreshes the
        // account catalog. Do not authorize a body that changed or was withheld
        // during that evaluation, even if the skill's visible name is unchanged.
        if (!await current()) return new Response(null, { status: 403 });
        return Response.json({ ...permission, ...(permission.data.effect === "allow" ? { authorized: input.skills } : {}) });
      }
      // Internal plugin read: one listed skill's SKILL.md for native delivery.
      if (call.name === "openwork_skill_read") {
        const input = z.object({ url: z.string().startsWith("skill://").max(2_048) }).parse(call.input);
        return Response.json(await read("/experimental/connect/skills/read", { method: "POST", body: JSON.stringify(input) }));
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
