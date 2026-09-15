import { PROGRESS_AGENT, PROGRESS_LIMITS, PROGRESS_SYSTEM } from "../src/lib/progress-config.ts";
import { PROGRESS_STATES } from "../src/lib/progress-service.ts";
import { EXECUTION_KINDS, EXECUTION_STATES } from "../src/lib/work-receipt.ts";
import { installNativePlugin } from "./native-plugin.mjs";
import { withoutIsolatedAgent, isolatedModelSource } from "./isolated-model-plugin.mjs";

const policy = {
  agent: PROGRESS_AGENT, limits: PROGRESS_LIMITS, system: PROGRESS_SYSTEM,
  statuses: [...Object.values(PROGRESS_STATES).map((label) => `${label}.`), ...Object.values(EXECUTION_KINDS).flatMap((kind) => Object.values(EXECUTION_STATES).map((state) => `${kind}: ${state}.`))],
};

function validateProgress(text) {
  const { limits, system, statuses } = policy;
  const refuse = () => { throw new Error("Progress selection refused."); };
  const number = "(?:0|[1-9][0-9]{0,2}|999\\+)";
  const steps = new RegExp(`^(?:${number} tool steps? completed(?:; ${number} failed)?|${number} tool steps? failed)\\.$`);
  const dependencies = new RegExp(`^Pending: (?:${number} coworker results?(?: and ${number} Worker results?)?|${number} Worker results?)\\.$`);
  if (typeof text !== "string" || /[^\x20-\x7e]/.test(text) || text.length + system.length + limits.inputFramingBytes > limits.maxInputBytes) refuse();
  let facts;
  try { facts = JSON.parse(text); } catch { refuse(); }
  if (!Array.isArray(facts) || facts.length < 1 || facts.length > limits.maxFacts || facts[0]?.id !== "status" || new Set(facts.map((fact) => fact?.id)).size !== facts.length) refuse();
  for (const fact of facts) {
    if (!fact || Object.keys(fact).sort().join() !== "id,text" || typeof fact.text !== "string") refuse();
    if (!(fact.id === "status" ? statuses.includes(fact.text) : fact.id === "steps" ? steps.test(fact.text) : fact.id === "dependencies" ? dependencies.test(fact.text) : false)) refuse();
  }
}

export const PROGRESS_PLUGIN = isolatedModelSource(policy, validateProgress.toString());

export async function installProgressPlugin(coordinator) {
  await installNativePlugin(coordinator, "progress-summary.js", (config) => withoutIsolatedAgent(config, policy));
}
