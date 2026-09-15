import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REACTION_DESCRIPTION } from "./message-reactions-context.mjs";
import { installNativePlugin, NATIVE_BROKER_SOURCE } from "./native-plugin.mjs";
import { installTurnRolesPlugin } from "./turn-roles-plugin.mjs";

// This source is copied into the coworker's managed configuration before its
// engine workspace opens. Only ToolContext supplies execution identity.
export const COLLABORATION_PLUGIN = NATIVE_BROKER_SOURCE + `
export default Plugin.define({ id: "coworker.collaboration", effect: (ctx) => Effect.gen(function* () {
  const continuation = schema.object({
    objective: schema.string().max(4000),
    refs: schema.array(schema.string().max(300)).max(8).optional(),
    completedActions: schema.array(schema.string().max(300)).max(8).optional(),
    resumeInstructions: schema.string().max(4000),
  });
  const define = (name, description, fields) => {
    const input = schema.object(fields).strict();
    return { ...brokerTool(ctx, name, input, description, { textOnly: true }), name: "coworker_" + name };
  };
  const tools = [
    define("react", ${JSON.stringify(REACTION_DESCRIPTION)},
      { emoji: schema.string().min(1).max(64).nullable(), messageId: schema.string().min(1).max(256).optional() }),
    define("team_consult", "Ask one teammate a focused question needed for this task. The question and explicit context appear in a shared pair/group conversation. Never copy private transcript or memory. Give the continuation objective, completed actions and next instructions, NOT reasoning. This returns an acknowledgement, not the answer: end your turn and the app resumes you here once all results arrive. Never poll, self-consult, or call from a Worker.",
      { to: schema.string().max(64), question: schema.string().min(1).max(4000), context: schema.string().max(2000).optional(), continuation }),
    define("worker_spawn", "Start a Worker for one bounded goal beyond this reply. Record the original objective and how to use its result, then acknowledge and END this turn. The app delivers a follow-up here when the Worker finishes; never poll or wait in this turn. Use an assignment for scheduled work. Workers cannot start Workers.",
      { name: schema.string().min(1).max(80), goal: schema.string().min(1).max(4000), skills: schema.array(schema.object({ id: schema.string().min(1).max(2048) }).strict()).max(32).optional().describe("Exact IDs from this workspace's native skill catalog, never names or bodies. Workers also discover and load skills natively without attachments."), purpose: schema.enum(["thinking", "delivery"]).optional().describe("Thinking for a bounded brief on hard ambiguity; delivery for heavier execution while you stay available. Default delivery. Follow the Workers contract. Model: coworker role override, then app default, then role-based automatic; pinned at start."), control: schema.enum(["browser", "computer"]).optional().describe("Request one control surface from THIS saved private discussion for this delivery goal. The Worker waits without executing until the person approves it. Computer also needs discussion opt-in and fresh native window consent. Never inherited by automatic follow-ups."), lifespan: schema.object({ kind: schema.enum(["turns", "until"]), turns: schema.number().int().min(1).max(100).optional(), until: schema.string().optional() }).optional(), continuation }),
    define("worker_steer", "Queue a correction for a Worker's next bounded step. For control work, use only its original private discussion and stay within the approved goal/surface. This does not interrupt the current step, grant permissions or resume human takeover. Pause/stop instead if input must stop now.", { id: schema.string(), text: schema.string().min(1).max(4000) }),
    define("worker_pause", "Pause a Worker when asked. Ordinary Workers finish their step; control Workers stop input immediately and need new person approval to continue.", { id: schema.string() }),
    define("worker_resume", "Resume an ordinary paused Worker when asked. Cannot restore control approval: the person must approve a control Worker in its original discussion.", { id: schema.string() }),
    define("worker_cancel", "Stop a Worker permanently when done or asked. Control work stops input before record updates; uncertain cleanup remains blocked. Never stop a person-started Worker unless asked.", { id: schema.string(), reason: schema.string().max(1000).optional() }),
  ];
  yield* ctx.tool.transform((editor) => { for (const tool of tools) editor.add(tool); });
}) });
`;

/** Native custom roles deny question by default. Supply the interactive-client
 * default only where the person has not already set a question/catch-all rule. */
export function withInteractiveQuestionDefault(config) {
  const permissions = config.permissions ?? [];
  const matchesQuestion = (action) => new RegExp("^" + [...action].map((char) => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$+.[\]{}()|]/g, "\\$&")).join("") + "$").test("question");
  if (!Array.isArray(permissions) || permissions.some((rule) => matchesQuestion(rule.action))) return config;
  return { ...config, permissions: [...permissions, { action: "question", resource: "*", effect: "allow" }] };
}

export async function installCollaborationPlugin(coworker, config) {
  const root = path.join(coworker.path, ".opencode");
  await mkdir(root, { recursive: true });
  const connectionFile = path.join(root, "coworker-context.json");
  const connection = JSON.stringify(config);
  if (await readFile(connectionFile, "utf8").catch(() => "") !== connection) await writeFile(connectionFile, connection, { mode: 0o600 });
  await installNativePlugin(coworker, "coworker-collaboration.js", withInteractiveQuestionDefault);
  await installTurnRolesPlugin(coworker);
}
