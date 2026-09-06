import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROGRESS_AGENT, PROGRESS_LIMITS, PROGRESS_SYSTEM } from "../src/lib/progress-config.ts";
import { PROGRESS_STATES } from "../src/lib/progress-service.ts";
import { EXECUTION_KINDS, EXECUTION_STATES } from "../src/lib/work-receipt.ts";

const policy = {
  agent: PROGRESS_AGENT, limits: PROGRESS_LIMITS, system: PROGRESS_SYSTEM,
  statuses: [...Object.values(PROGRESS_STATES).map((label) => `${label}.`), ...Object.values(EXECUTION_KINDS).flatMap((kind) => Object.values(EXECUTION_STATES).map((state) => `${kind}: ${state}.`))],
};

// Self-contained: copied to the coordinator, with no runtime imports or tools.
// Keep every captured value in policy so packaged and fixture hooks are identical.
export async function progressHooks({ agent, limits, system, statuses } = policy) {
  const sessions = new Map();
  const refuse = () => { throw new Error("Progress selection refused."); };
  const number = "(?:0|[1-9][0-9]{0,2}|999\\+)";
  const steps = new RegExp(`^(?:${number} tool steps? completed(?:; ${number} failed)?|${number} tool steps? failed)\\.$`);
  const dependencies = new RegExp(`^Pending: (?:${number} coworker results?(?: and ${number} Worker results?)?|${number} Worker results?)\\.$`);
  const safePrompt = (text) => {
    if (typeof text !== "string" || /[^\x20-\x7e]/.test(text) || text.length + system.length + limits.inputFramingBytes > limits.maxInputBytes) refuse();
    let facts;
    try { facts = JSON.parse(text); } catch { refuse(); }
    if (!Array.isArray(facts) || facts.length < 1 || facts.length > limits.maxFacts || facts[0]?.id !== "status" || new Set(facts.map((fact) => fact?.id)).size !== facts.length) refuse();
    for (const fact of facts) {
      if (!fact || Object.keys(fact).sort().join() !== "id,text" || typeof fact.text !== "string") refuse();
      if (!(fact.id === "status" ? statuses.includes(fact.text) : fact.id === "steps" ? steps.test(fact.text) : fact.id === "dependencies" ? dependencies.test(fact.text) : false)) refuse();
    }
  };
  return {
    config: async (config) => {
      config.agent ??= {};
      // Register ONLY through this hook: a missing plugin leaves an unknown agent.
      // Do not set steps: 1: native appends a max-steps assistant instruction
      // after message transforms on the last step. The attempt guard owns the cap.
      config.agent[agent] = { hidden: true, mode: "subagent", description: "Select observed progress facts", prompt: system, permission: { "*": "deny" }, tools: { "*": false } };
    },
    "chat.message": async (input, output) => {
      if (input.agent !== agent) return;
      if (sessions.has(input.sessionID) || !input.model || output.parts.length !== 1 || output.parts[0].type !== "text" || output.message.format?.type === "json_schema") refuse();
      safePrompt(output.parts[0].text);
      delete output.message.system;
      delete output.message.format;
      output.message.tools = { "*": false };
      const part = output.parts[0];
      output.parts[0] = { id: part.id, sessionID: input.sessionID, messageID: output.message.id, type: "text", text: part.text };
      sessions.set(input.sessionID, { used: false, model: input.model, message: output.message, part: { ...output.parts[0] } });
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const registered = output.messages.find((message) => sessions.has(message.info.sessionID));
      if (!registered) return;
      const session = sessions.get(registered.info.sessionID);
      // Drop injected reminders, workspace instructions, history and synthetic parts.
      output.messages.splice(0, output.messages.length, { info: session.message, parts: [{ ...session.part }] });
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (sessions.has(input.sessionID)) output.system.splice(0, output.system.length, system);
    },
    "chat.params": async (input, output) => {
      const session = sessions.get(input.sessionID);
      if (!session && input.agent !== agent) return;
      if (!session || input.agent !== agent || session.used || input.model.providerID !== session.model.providerID || input.model.id !== session.model.modelID) refuse();
      // The native retry loop calls chat.params again. A plain error without a
      // retryable status/message stops it BEFORE another provider request.
      session.used = true;
      // Older engines do not expose this top-level parameter. Never infer on
      // an engine that would silently ignore a plugin-added cap field.
      if (!Object.hasOwn(output, "maxOutputTokens")) refuse();
      const model = input.model;
      if (!["@ai-sdk/openai", "@ai-sdk/openai-compatible"].includes(model.api?.npm) || model.status !== "active" || model.capabilities?.reasoning !== false || model.capabilities?.input?.text !== true || model.capabilities?.output?.text !== true
        || !Number.isFinite(model.cost?.input) || model.cost.input <= 0 || model.cost.input > limits.maxInputPrice
        || !Number.isFinite(model.cost?.output) || model.cost.output <= 0 || model.cost.output > limits.maxOutputPrice) refuse();
      output.maxOutputTokens = Math.min(limits.maxOutputTokens, Number.isFinite(output.maxOutputTokens) && output.maxOutputTokens > 0 ? output.maxOutputTokens : limits.maxOutputTokens);
      // No inherited reasoning, prompt, response format, or provider option can
      // weaken this request. These are per-call hook values, not provider config.
      const instructions = Object.hasOwn(output.options, "instructions");
      for (const key of Object.keys(output.options)) delete output.options[key];
      if (instructions) output.options.instructions = system;
      output.temperature = 0;
      output.topP = 1;
      output.topK = undefined;
    },
    "tool.execute.before": async (input) => { if (sessions.has(input.sessionID)) refuse(); },
    "experimental.session.compacting": async (input) => { if (sessions.has(input.sessionID)) refuse(); },
  };
}

export const PROGRESS_PLUGIN = `export default async () => (${progressHooks.toString()})(${JSON.stringify(policy)});\n`;

export async function installProgressPlugin(coordinator) {
  const root = path.join(coordinator.path, ".opencode");
  await mkdir(root, { recursive: true });
  const source = path.join(root, "progress-summary.js");
  if (await readFile(source, "utf8").catch(() => "") !== PROGRESS_PLUGIN) await writeFile(source, PROGRESS_PLUGIN, "utf8");
  const target = path.join(coordinator.path, "opencode.json");
  const current = JSON.parse(await readFile(target, "utf8"));
  const plugin = pathToFileURL(source).href;
  if ((current.plugin ?? []).includes(plugin)) return;
  await writeFile(`${target}.progress.tmp`, JSON.stringify({ ...current, plugin: [...(current.plugin ?? []), plugin] }, null, 2), "utf8");
  await rename(`${target}.progress.tmp`, target);
}
