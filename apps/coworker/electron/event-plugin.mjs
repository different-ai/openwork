import { eventToolCatalog } from "./events.mjs";
import { installNativePlugin, NATIVE_BROKER_SOURCE } from "./native-plugin.mjs";

export const EVENT_PLUGIN = NATIVE_BROKER_SOURCE + `
export default Plugin.define({ id: "coworker.events", effect: (ctx) => Effect.gen(function* () {
  const descriptions = ${JSON.stringify(Object.fromEntries(eventToolCatalog().map(({ name, description }) => [name.slice("coworker_".length), description])))};
  const lines = schema.array(schema.string().max(1200)).max(20);
  const artifact = schema.object({ owner: schema.union([
    schema.object({ kind: schema.literal("coworker"), slug: schema.string(), createdAt: schema.string() }),
    schema.object({ kind: schema.literal("group"), groupId: schema.string() })
  ]), documentId: schema.string(), title: schema.string(), revision: schema.number().int().positive(), relation: schema.enum(["used", "created", "modified"]), contributorSlug: schema.string() });
  const timezone = schema.string().min(1).max(120);
  const schedule = schema.union([
    schema.object({ kind: schema.literal("once"), timezone, at: schema.number().int().nonnegative() }),
    schema.object({ kind: schema.literal("daily"), timezone, hour: schema.number().int().min(0).max(23), minute: schema.number().int().min(0).max(59) }),
    schema.object({ kind: schema.literal("weekly"), timezone, hour: schema.number().int().min(0).max(23), minute: schema.number().int().min(0).max(59), daysOfWeek: schema.array(schema.number().int().min(0).max(6)).min(1).max(7) }),
  ]);
  const eventInput = schema.object({ title: schema.string().min(1).max(160), description: schema.string().max(4000).optional(), objective: schema.string().min(1).max(4000),
    template: schema.enum(["working-session", "all-hands"]).optional(), leadSlug: schema.string().min(1), participantSlugs: schema.array(schema.string().min(1)).min(1).max(20),
    startsAt: schema.number().int().nonnegative(), schedule, repeatUntil: schema.number().int().nonnegative().nullable().optional(),
    durationMinutes: schema.number().int().min(5).max(240).nullable().optional(), maxReplies: schema.number().int().min(2).max(40).optional(),
    state: schema.enum(["active", "paused", "archived"]).optional(), artifacts: schema.array(artifact).max(30).optional() }).strict();
  const updateInput = eventInput.required({ description: true, template: true, durationMinutes: true, maxReplies: true, state: true, artifacts: true });
  const define = (name, description, args) => ({ ...brokerTool(ctx, name, schema.object(args).strict(), description, { textOnly: true }), name: "coworker_" + name });
  const tools = {
    coworker_workplace_calendar: define("workplace_calendar", descriptions.workplace_calendar, { after: schema.number().int().nonnegative().optional(), before: schema.number().int().nonnegative().optional() }),
    coworker_event_details: define("event_details", descriptions.event_details, { id: schema.string().min(1).max(160), runId: schema.string().min(1).max(160).optional() }),
    coworker_event_document_read: define("event_document_read", descriptions.event_document_read, { id: schema.string().min(1).max(160), runId: schema.string().min(1).max(160), artifact }),
    coworker_event_conclude: define("event_conclude", descriptions.event_conclude, { outcome: schema.object({ summary: schema.string().min(1).max(6000), decisions: lines, accomplishments: lines, openQuestions: lines, followUps: lines }) }),
    coworker_event_create: define("event_create", descriptions.event_create, { input: eventInput }),
    coworker_event_update: define("event_update", descriptions.event_update, { id: schema.string().min(1).max(160), input: updateInput, expectedRevision: schema.number().int().positive() }),
    coworker_event_manage: define("event_manage", descriptions.event_manage, { id: schema.string().min(1).max(160), action: schema.enum(["pause", "resume", "archive", "run_now", "cancel_run"]), expectedRevision: schema.number().int().positive().optional(), runId: schema.string().min(1).max(160).optional() }),
  };
  yield* ctx.tool.transform((editor) => { for (const tool of Object.values(tools)) editor.add(tool); });
}) });
`;

export async function installEventPlugin(coworker) {
  await installNativePlugin(coworker, "coworker-events.js");
}
