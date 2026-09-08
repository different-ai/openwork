/**
 * The app's own tools for coworkers, served as a small MCP server on loopback.
 *
 * Open Coworker gives each coworker a handful of tools the platform does not
 * have — documents and the active context around them — without inventing a
 * second tool protocol: the Electron main process answers MCP over HTTP on
 * 127.0.0.1, and the embedded server registers that endpoint in each coworker
 * workspace exactly like any other remote MCP (`POST /workspace/:id/mcp`). A
 * per-coworker bearer token names the coworker, so the tools never take a
 * coworker id from the model.
 *
 * Only the subset of MCP Streamable HTTP the engine's client needs is spoken:
 * `initialize`, `notifications/initialized`, `ping`, `tools/list`, and
 * `tools/call`, each answered as one JSON response. No sessions, no
 * server-initiated stream (GET answers 405, which the client treats as "not
 * offered"). No Electron imports: exercised directly by `node --test`.
 */
import { createServer } from "node:http";
import {
  ACTIVE_SET_TARGET,
  archiveDocument,
  createDocument,
  listDocuments,
  listSections,
  readDocument,
  recordStyleEvent,
  setContext,
  updateDocument,
} from "./documents.mjs";

/** The MCP name in each workspace; tools reach the model as `coworker_<tool>`. */
export const COWORKER_TOOLS_MCP_NAME = "coworker";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/**
 * What the engine shows the model about this server. The rules for when to use
 * each tool live in the coworker's AGENTS.md and are said once, there; this line
 * only says whose tools these are and where the rules are.
 */
export const DEFAULT_INSTRUCTIONS = "Open Coworker's own tools for this coworker: documents, Workers, assignments, memory and soul, and the team. When to use each is in AGENTS.md (How I talk, Workers, My team, Keeping memory and soul current, Scheduling).";

const DOCUMENT_ID_SCHEMA = { type: "string", description: "The document id, as listed in documents/index.md or returned when it was created." };

/** What the coworker can do with its documents, described in its own plain words. */
export function toolCatalog() {
  return [
    {
      name: "documents_list",
      description: "List my documents: active, put aside, and archived, with each one's summary and highlights. Use it before deciding whether to update an existing document or start a new one.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "document_create",
      description: "Write a new document beside the conversation for anything substantial (a plan, a comparison, research, a draft, notes). Give it a title, a one-sentence summary, three to five highlights, and a Markdown body with ## sections. Then answer the person with the short version and name the document — never paste it into the message.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short and specific, e.g. \"Launch plan\"." },
          summary: { type: "string", description: "One sentence saying what the document holds." },
          highlights: { type: "array", items: { type: "string" }, maxItems: 5, description: "Three to five short lines: the takeaways." },
          body: { type: "string", description: "Markdown with ## sections. Do not repeat the title as a heading." },
        },
        required: ["title", "summary", "body"],
        additionalProperties: false,
      },
    },
    {
      name: "document_update",
      description: "Update one of my documents. Send either a whole new body or a patch that replaces one ## section by its heading (add the section when it is new). Refresh summary and highlights whenever the body changes. Ask first if the document was edited by the person.",
      inputSchema: {
        type: "object",
        properties: {
          id: DOCUMENT_ID_SCHEMA,
          title: { type: "string" },
          summary: { type: "string", description: "The refreshed one-sentence summary." },
          highlights: { type: "array", items: { type: "string" }, maxItems: 5 },
          body: { type: "string", description: "The whole new Markdown body. Omit when sending a patch." },
          patch: {
            type: "object",
            description: "Replace one ## section: its heading and the new content for that section only.",
            properties: {
              heading: { type: "string", description: "The section's ## heading, e.g. \"Timeline\"." },
              content: { type: "string", description: "The new Markdown for that section, without the heading line." },
            },
            required: ["heading", "content"],
            additionalProperties: false,
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "document_read",
      description: "Read one of my documents in full (frontmatter facts plus the Markdown body).",
      inputSchema: { type: "object", properties: { id: DOCUMENT_ID_SCHEMA }, required: ["id"], additionalProperties: false },
    },
    {
      name: "context_set",
      description: "Keep the active set to what the current work needs (about five). Ids under `active` become active; ids under `aside` are put aside. Call it every time I create or refresh a document. Never archives.",
      inputSchema: {
        type: "object",
        properties: {
          active: { type: "array", items: { type: "string" }, description: "Document ids to keep or bring back into play." },
          aside: { type: "array", items: { type: "string" }, description: "Document ids the current work no longer needs." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "document_archive",
      description: "Archive a document — only when the person asked for that in so many words. Otherwise put it aside with context_set; archiving is the person's call.",
      inputSchema: {
        type: "object",
        properties: {
          id: DOCUMENT_ID_SCHEMA,
          reason: { type: "string", description: "What the person said." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ];
}

/** The fields a card in the conversation shows for a document. */
export function documentCard(document, extra = {}) {
  return {
    id: document.id,
    title: document.title,
    summary: document.summary,
    highlights: document.highlights.slice(0, 3),
    status: document.status,
    revision: document.revision,
    updatedAt: document.updatedAt,
    ...extra,
  };
}

function describeList(documents) {
  if (documents.length === 0) return "No documents yet.";
  const groups = [
    ["Active", documents.filter((document) => document.status === "active")],
    ["Put aside", documents.filter((document) => document.status === "aside")],
    ["Archived", documents.filter((document) => document.status === "archived")],
  ];
  const lines = [];
  for (const [label, items] of groups) {
    if (items.length === 0) continue;
    lines.push(`${label} (${items.length}):`);
    for (const document of items) {
      const edited = document.updatedBy === "person" ? " · edited by the person" : "";
      lines.push(`- ${document.id} — ${document.title} — ${document.summary || "(no summary)"} (revision ${document.revision}${edited})`);
      for (const highlight of document.highlights) lines.push(`    • ${highlight}`);
    }
  }
  return lines.join("\n");
}

function describeContextOutcome(outcome) {
  const parts = [];
  for (const change of outcome.changed) parts.push(`${change.status === "aside" ? "Put aside" : "Made active"}: ${change.title}.`);
  if (parts.length === 0) parts.push("The active set is unchanged.");
  if (outcome.unknown.length > 0) parts.push(`No document has the id ${outcome.unknown.join(", ")}.`);
  if (outcome.skippedArchived.length > 0) parts.push(`${outcome.skippedArchived.join(", ")} stays archived; only the person restores an archived document.`);
  parts.push(`${outcome.activeCount} active document${outcome.activeCount === 1 ? "" : "s"}.`);
  if (outcome.overTarget) parts.push(`That is more than about ${ACTIVE_SET_TARGET}; put aside what the current work no longer needs.`);
  return parts.join(" ");
}

function text(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Tool handlers keyed by tool name. Each receives the coworker slug the token
 * resolved to and the model's arguments, and returns `{ text, structured }`:
 * one plain sentence for the model and the card fields for the app.
 */
export function createToolHandlers({ coworkersDir, onChange = () => undefined }) {
  const changed = (slug, kind) => {
    try {
      onChange(slug, kind);
    } catch {
      // A listener must never fail a tool call.
    }
  };
  return {
    documents_list: async (slug) => {
      const documents = await listDocuments(coworkersDir, slug);
      return {
        text: describeList(documents),
        structured: { documents: documents.map((document) => documentCard(document)) },
      };
    },
    document_create: async (slug, args) => {
      const document = await createDocument(coworkersDir, slug, {
        title: text(args.title),
        summary: text(args.summary),
        highlights: args.highlights,
        body: text(args.body),
      });
      await recordStyleEvent(coworkersDir, slug, { kind: "document" }).catch(() => undefined);
      changed(slug, "created");
      const active = (await listDocuments(coworkersDir, slug)).filter((item) => item.status === "active").length;
      return {
        text: `Wrote "${document.title}" (id ${document.id}, revision 1). ${active} active document${active === 1 ? "" : "s"}${active > ACTIVE_SET_TARGET ? ` — more than about ${ACTIVE_SET_TARGET}; call context_set to put aside what this work no longer needs` : ""}. Now answer with the short version and name the document.`,
        structured: { document: documentCard(document, { action: "created" }) },
      };
    },
    document_update: async (slug, args) => {
      const id = text(args.id);
      const patch = args.patch && typeof args.patch === "object"
        ? { heading: text(args.patch.heading), content: text(args.patch.content) }
        : undefined;
      if (!patch && typeof args.body !== "string" && typeof args.summary !== "string" && args.highlights === undefined && typeof args.title !== "string") {
        throw new Error("Send a new body, a section patch, or refreshed summary/highlights.");
      }
      const updated = await updateDocument(coworkersDir, slug, id, {
        ...(typeof args.title === "string" ? { title: args.title } : {}),
        ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
        ...(args.highlights !== undefined ? { highlights: args.highlights } : {}),
        ...(patch ? { patch } : typeof args.body === "string" ? { body: args.body } : {}),
      });
      if (!updated.changed) {
        return {
          text: `"${updated.title}" already says that; nothing changed (still revision ${updated.revision}).`,
          structured: { document: documentCard(updated, { action: "unchanged", section: updated.section }) },
        };
      }
      await recordStyleEvent(coworkersDir, slug, { kind: "document" }).catch(() => undefined);
      changed(slug, "updated");
      const where = updated.section
        ? ` — ${updated.sectionAction === "appended" ? "added" : "replaced"} the "${updated.section}" section`
        : "";
      return {
        text: `Updated "${updated.title}" to revision ${updated.revision}${where}. Sections now: ${listSections(updated.body).map((section) => section.heading).join(", ") || "none"}. Answer with the short version and name the document.`,
        structured: { document: documentCard(updated, { action: "updated", section: updated.section }) },
      };
    },
    document_read: async (slug, args) => {
      const document = await readDocument(coworkersDir, slug, text(args.id));
      const facts = [
        `# ${document.title}`,
        `id: ${document.id} · status: ${document.status} · revision ${document.revision} · last updated by the ${document.updatedBy}`,
        document.summary ? `Summary: ${document.summary}` : "",
        document.highlights.length > 0 ? `Highlights:\n${document.highlights.map((line) => `- ${line}`).join("\n")}` : "",
        "",
        document.body,
      ].filter((line) => line !== "").join("\n");
      return { text: facts, structured: { document: documentCard(document, { action: "read" }) } };
    },
    context_set: async (slug, args) => {
      const outcome = await setContext(coworkersDir, slug, { active: args.active, aside: args.aside });
      if (outcome.changed.length > 0) changed(slug, "context");
      return {
        text: describeContextOutcome(outcome),
        structured: { changed: outcome.changed, unknown: outcome.unknown, activeCount: outcome.activeCount },
      };
    },
    document_archive: async (slug, args) => {
      const document = await archiveDocument(coworkersDir, slug, text(args.id));
      changed(slug, "archived");
      return {
        text: `Archived "${document.title}". It stays on disk behind the Archived link in the Documents view; only the person can bring it back.`,
        structured: { document: documentCard(document, { action: "archived" }) },
      };
    },
  };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function negotiateProtocol(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * Answer one JSON-RPC message for a coworker. Notifications return null (the
 * HTTP layer replies 202). Tool failures become `isError` results with a plain
 * sentence, so the model can act on them; protocol failures become errors.
 */
export async function handleMcpMessage(message, { slug, handlers, tools, serverInfo, instructions = DEFAULT_INSTRUCTIONS }) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(message?.id ?? null, -32600, "Invalid request");
  }
  const id = message.id;
  const isNotification = id === undefined || id === null;
  if (message.method.startsWith("notifications/")) return null;
  if (isNotification) return null;
  switch (message.method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocol(message.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions,
      });
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, { tools });
    case "tools/call": {
      const name = typeof message.params?.name === "string" ? message.params.name : "";
      const handler = handlers[name];
      if (!handler) return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
      const args = message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
      try {
        const outcome = await handler(slug, args);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: outcome.text }],
          ...(outcome.structured ? { structuredContent: outcome.structured } : {}),
          isError: false,
        });
      } catch (error) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function bearerToken(request) {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)$/i.exec(String(value ?? "").trim());
  return match ? match[1].trim() : "";
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

/**
 * Start the loopback MCP server. `resolveSlug(token)` names the coworker a
 * bearer token belongs to (null rejects the request). Returns the base URL the
 * engine connects to and the config to register in a workspace.
 */
export async function createCoworkerToolsServer({ resolveSlug, handlers, onContextTool, tools = toolCatalog(), instructions = DEFAULT_INSTRUCTIONS, version = "0.0.0", host = "127.0.0.1", port = 0 }) {
  const serverInfo = { name: "open-coworker", version };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp" && !(url.pathname === "/context" && onContextTool)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const slug = resolveSlug(bearerToken(request));
    if (!slug) {
      sendJson(response, 401, { error: "unauthorized", message: "This coworker token is not known to Open Coworker." });
      return;
    }
    if (url.pathname === "/context") {
      if (request.method !== "POST") { sendJson(response, 405, { error: "Use POST." }); return; }
      try { sendJson(response, 200, await onContextTool(slug, JSON.parse(await readBody(request)))); }
      catch (error) { sendJson(response, 400, { error: error.message || "Collaboration could not be requested." }); }
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405, { Allow: "POST, DELETE" });
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, DELETE" });
      response.end();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(await readBody(request));
    } catch (error) {
      sendJson(response, 400, jsonRpcError(null, -32700, error instanceof Error ? error.message : "Parse error"));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const replies = (await Promise.all(messages.map((message) => handleMcpMessage(message, { slug, handlers, tools, serverInfo, instructions })))).filter(Boolean);
    if (replies.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
  });
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${boundPort}`;
  return {
    url: `${baseUrl}/mcp`,
    port: boundPort,
    /** The workspace MCP entry for one coworker's token — the same shape the Connect gateway uses. */
    mcpConfig: (token) => ({
      type: "remote",
      enabled: true,
      url: `${baseUrl}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
      oauth: false,
    }),
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
