import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eventToolCatalog } from "./events.mjs";

export const EVENT_PLUGIN = `import { tool } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import path from "node:path";
export default async ({ directory }) => {
  const calls = new Map();
  const descriptions = ${JSON.stringify(Object.fromEntries(eventToolCatalog().map(({ name, description }) => [name.slice("coworker_".length), description])))};
  const lines = tool.schema.array(tool.schema.string().max(1200)).max(20);
  const artifact = tool.schema.object({ owner: tool.schema.union([
    tool.schema.object({ kind: tool.schema.literal("coworker"), slug: tool.schema.string(), createdAt: tool.schema.string() }),
    tool.schema.object({ kind: tool.schema.literal("group"), groupId: tool.schema.string() })
  ]), documentId: tool.schema.string(), title: tool.schema.string(), revision: tool.schema.number().int().positive(), relation: tool.schema.enum(["used", "created", "modified"]), contributorSlug: tool.schema.string() });
  const timezone = tool.schema.string().min(1).max(120);
  const schedule = tool.schema.union([
    tool.schema.object({ kind: tool.schema.literal("once"), timezone, at: tool.schema.number().int().nonnegative() }),
    tool.schema.object({ kind: tool.schema.literal("daily"), timezone, hour: tool.schema.number().int().min(0).max(23), minute: tool.schema.number().int().min(0).max(59) }),
    tool.schema.object({ kind: tool.schema.literal("weekly"), timezone, hour: tool.schema.number().int().min(0).max(23), minute: tool.schema.number().int().min(0).max(59), daysOfWeek: tool.schema.array(tool.schema.number().int().min(0).max(6)).min(1).max(7) }),
  ]);
  const eventInput = tool.schema.object({ title: tool.schema.string().min(1).max(160), description: tool.schema.string().max(4000).optional(), objective: tool.schema.string().min(1).max(4000),
    template: tool.schema.enum(["working-session", "all-hands"]).optional(), leadSlug: tool.schema.string().min(1), participantSlugs: tool.schema.array(tool.schema.string().min(1)).min(1).max(20),
    startsAt: tool.schema.number().int().nonnegative(), schedule, repeatUntil: tool.schema.number().int().nonnegative().nullable().optional(),
    durationMinutes: tool.schema.number().int().min(5).max(240).nullable().optional(), maxReplies: tool.schema.number().int().min(2).max(40).optional(),
    state: tool.schema.enum(["active", "paused", "archived"]).optional(), artifacts: tool.schema.array(artifact).max(30).optional() }).strict();
  const updateInput = eventInput.required({ description: true, template: true, durationMinutes: true, maxReplies: true, state: true, artifacts: true });
  const define = (name, description, args) => tool({ description, args, execute: async (input, context) => {
    tool.schema.object(args).strict().parse(input);
    const key = JSON.stringify([context.sessionID, "coworker_" + name, input]);
    const queue = calls.get(key) || [];
    let callID = context.callID;
    if (callID) { const index = queue.indexOf(callID); if (index !== -1) queue.splice(index, 1); }
    else callID = queue.shift();
    if (!queue.length) calls.delete(key);
    if (!context.sessionID || !context.messageID || !callID || !context.abort) throw new Error("Native event tools require an active tool-call identity.");
    context.abort.throwIfAborted();
    const config = JSON.parse(await readFile(path.join(directory, ".opencode", "coworker-context.json"), "utf8"));
    const response = await fetch(config.url, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.token },
      body: JSON.stringify({ name, args: input, context: { sessionID: context.sessionID, messageID: context.messageID, callID, directory: context.directory || directory } }),
      signal: AbortSignal.any([context.abort, AbortSignal.timeout(20000)]) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Event operation failed. Inspect its record before retrying.");
    return result.text;
  } });
  const tools = {
    coworker_workplace_calendar: define("workplace_calendar", descriptions.workplace_calendar, { after: tool.schema.number().int().nonnegative().optional(), before: tool.schema.number().int().nonnegative().optional() }),
    coworker_event_details: define("event_details", descriptions.event_details, { id: tool.schema.string().min(1).max(160), runId: tool.schema.string().min(1).max(160).optional() }),
    coworker_event_document_read: define("event_document_read", descriptions.event_document_read, { id: tool.schema.string().min(1).max(160), runId: tool.schema.string().min(1).max(160), artifact }),
    coworker_event_conclude: define("event_conclude", descriptions.event_conclude, { outcome: tool.schema.object({ summary: tool.schema.string().min(1).max(6000), decisions: lines, accomplishments: lines, openQuestions: lines, followUps: lines }) }),
    coworker_event_create: define("event_create", descriptions.event_create, { input: eventInput }),
    coworker_event_update: define("event_update", descriptions.event_update, { id: tool.schema.string().min(1).max(160), input: updateInput, expectedRevision: tool.schema.number().int().positive() }),
    coworker_event_manage: define("event_manage", descriptions.event_manage, { id: tool.schema.string().min(1).max(160), action: tool.schema.enum(["pause", "resume", "archive", "run_now", "cancel_run"]), expectedRevision: tool.schema.number().int().positive().optional(), runId: tool.schema.string().min(1).max(160).optional() }),
  };
  return { "tool.execute.before": async (input, output) => {
    if (!Object.hasOwn(tools, input.tool) || !input.callID) return;
    const key = JSON.stringify([input.sessionID, input.tool, output.args]);
    calls.set(key, [...(calls.get(key) || []), input.callID]);
  }, tool: tools };
};
`;

export async function installEventPlugin(coworker) {
  const root = path.join(coworker.path, ".opencode");
  await mkdir(root, { recursive: true });
  const source = path.join(root, "coworker-events.js");
  if (await readFile(source, "utf8").catch(() => "") !== EVENT_PLUGIN) await writeFile(source, EVENT_PLUGIN, "utf8");
  const target = path.join(coworker.path, "opencode.json");
  const config = JSON.parse(await readFile(target, "utf8"));
  const plugin = pathToFileURL(source).href;
  if ((config.plugin ?? []).includes(plugin)) return;
  await writeFile(`${target}.events.tmp`, JSON.stringify({ ...config, plugin: [...(config.plugin ?? []), plugin] }, null, 2), "utf8");
  await rename(`${target}.events.tmp`, target);
}
