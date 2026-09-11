import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// This source is copied into the coworker's managed configuration before its
// engine workspace opens. Only ToolContext supplies execution identity.
export const COLLABORATION_PLUGIN = `import { tool } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import path from "node:path";
export default async ({ directory }) => {
  const calls = new Map();
  const continuation = tool.schema.object({
    objective: tool.schema.string().max(4000),
    refs: tool.schema.array(tool.schema.string().max(300)).max(8).optional(),
    completedActions: tool.schema.array(tool.schema.string().max(300)).max(8).optional(),
    resumeInstructions: tool.schema.string().max(4000),
  });
  const execute = (name) => async (args, context) => {
    const key = JSON.stringify([context.sessionID, "coworker_" + name, args]);
    const queue = calls.get(key) || [];
    const hooked = queue.shift();
    const callID = context.callID || hooked;
    if (!queue.length) calls.delete(key);
    if (!callID) throw new Error("The engine did not provide a trusted tool-call identity.");
    const config = JSON.parse(await readFile(path.join(directory, ".opencode", "coworker-context.json"), "utf8"));
    const response = await fetch(config.url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.token },
      body: JSON.stringify({ name, args, context: { sessionID: context.sessionID, messageID: context.messageID, callID, directory: context.directory || directory } }),
      signal: AbortSignal.any([context.abort, AbortSignal.timeout(20000)]),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Collaboration is unavailable.");
    context.metadata({ title: result.text, metadata: { structuredContent: result.structured } });
    return result.text;
  };
  return { "tool.execute.before": async (input, output) => {
    if (!["coworker_team_consult", "coworker_worker_spawn", "coworker_worker_steer", "coworker_worker_pause", "coworker_worker_resume", "coworker_worker_cancel"].includes(input.tool)) return;
    const key = JSON.stringify([input.sessionID, input.tool, output.args]);
    calls.set(key, [...(calls.get(key) || []), input.callID]);
  }, tool: {
    coworker_team_consult: tool({
      description: "Ask one teammate a focused question needed for this task. The question and explicit context appear in a shared pair/group conversation. Never copy private transcript or memory. Give the continuation objective, completed actions and next instructions, NOT reasoning. This returns an acknowledgement, not the answer: end your turn and the app resumes you here once all results arrive. Never poll, self-consult, or call from a Worker.",
      args: { to: tool.schema.string().max(64), question: tool.schema.string().min(1).max(4000), context: tool.schema.string().max(2000).optional(), continuation }, execute: execute("team_consult"),
    }),
    coworker_worker_spawn: tool({
      description: "Start a Worker for one bounded goal beyond this reply. Record the original objective and how to use its result, then acknowledge and END this turn. The app delivers a follow-up here when the Worker finishes; never poll or wait in this turn. Use an assignment for scheduled work. Workers cannot start Workers.",
      args: { name: tool.schema.string().min(1).max(80), goal: tool.schema.string().min(1).max(4000), purpose: tool.schema.enum(["thinking", "delivery"]).optional().describe("Thinking for a bounded brief on hard ambiguity; delivery for heavier execution while you stay available. Default delivery. Follow the Workers contract. Model: coworker role override, then app default, then role-based automatic; pinned at start."), control: tool.schema.enum(["browser", "computer"]).optional().describe("Request one control surface from THIS saved private discussion for this delivery goal. The Worker waits without executing until the person approves it. Computer also needs discussion opt-in and fresh native window consent. Never inherited by automatic follow-ups."), lifespan: tool.schema.object({ kind: tool.schema.enum(["turns", "until"]), turns: tool.schema.number().int().min(1).max(100).optional(), until: tool.schema.string().optional() }).optional(), continuation }, execute: execute("worker_spawn"),
    }),
    coworker_worker_steer: tool({ description: "Queue a correction for a Worker's next bounded step. For control work, use only its original private discussion and stay within the approved goal/surface. This does not interrupt the current step, grant permissions or resume human takeover. Pause/stop instead if input must stop now.", args: { id: tool.schema.string(), text: tool.schema.string().min(1).max(4000) }, execute: execute("worker_steer") }),
    coworker_worker_pause: tool({ description: "Pause a Worker when asked. Ordinary Workers finish their step; control Workers stop input immediately and need new person approval to continue.", args: { id: tool.schema.string() }, execute: execute("worker_pause") }),
    coworker_worker_resume: tool({ description: "Resume an ordinary paused Worker when asked. Cannot restore control approval: the person must approve a control Worker in its original discussion.", args: { id: tool.schema.string() }, execute: execute("worker_resume") }),
    coworker_worker_cancel: tool({ description: "Stop a Worker permanently when done or asked. Control work stops input before record updates; uncertain cleanup remains blocked. Never stop a person-started Worker unless asked.", args: { id: tool.schema.string(), reason: tool.schema.string().max(1000).optional() }, execute: execute("worker_cancel") }),
  } };
};
`;

/** Native custom roles deny question by default. Supply the interactive-client
 * default only where the person has not already set a question/catch-all rule. */
export function withInteractiveQuestionDefault(config) {
  const permission = config.permission === undefined ? {} : config.permission;
  if (!permission || typeof permission !== "object" || Array.isArray(permission)
    || Object.hasOwn(permission, "question") || Object.hasOwn(permission, "*")
    || config.tools?.question === false || config.tools?.["*"] === false) return config;
  return { ...config, permission: { ...permission, question: "allow" } };
}

export async function installCollaborationPlugin(coworker, config) {
  const root = path.join(coworker.path, ".opencode");
  await mkdir(root, { recursive: true });
  const source = path.join(root, "coworker-collaboration.js");
  if (await readFile(source, "utf8").catch(() => "") !== COLLABORATION_PLUGIN) await writeFile(source, COLLABORATION_PLUGIN, "utf8");
  const connectionFile = path.join(root, "coworker-context.json");
  const connection = JSON.stringify(config);
  if (await readFile(connectionFile, "utf8").catch(() => "") !== connection) await writeFile(connectionFile, connection, { mode: 0o600 });
  const target = path.join(coworker.path, "opencode.json");
  const previous = JSON.parse(await readFile(target, "utf8"));
  const current = withInteractiveQuestionDefault(previous);
  const plugin = pathToFileURL(source).href;
  const installed = (current.plugin ?? []).includes(plugin);
  if (installed && current === previous) return;
  await writeFile(`${target}.collaboration.tmp`, JSON.stringify({ ...current, plugin: installed ? current.plugin : [...(current.plugin ?? []), plugin] }, null, 2), "utf8");
  await rename(`${target}.collaboration.tmp`, target);
}
