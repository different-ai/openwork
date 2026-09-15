import { COMPUTER_DENY } from "./computer-control.mjs";
import { workerTurnTools } from "./workers.mjs";
import { nativePermissions } from "./native-config.mjs";
import { COORDINATOR_AGENT as NATIVE_COORDINATOR_AGENT } from "./coordinator.mjs";
import { EVENT_WRITE_DENY, EVENT_SCHEDULE_DENY } from "./event-execution.mjs";

export { NATIVE_COORDINATOR_AGENT };

// A closed set, not an arbitrary tools-to-permissions converter. Keep the actual
// legacy masks as provenance; true control entries never become permission grants.
const bases = [
  { id: "coworker", tools: {} },
  { id: "coworker-no-computer", tools: { ...COMPUTER_DENY } },
  { id: "coworker-no-computer-no-reactions", tools: { ...COMPUTER_DENY, coworker_react: false } },
  { id: "coworker-no-referral", tools: { coworker_team_refer: false } },
  { id: "coworker-group", tools: { ...COMPUTER_DENY, coworker_team_refer: false } },
  { id: "coworker-worker", tools: workerTurnTools() },
  { id: "coworker-worker-browser", tools: workerTurnTools("browser") },
  { id: "coworker-worker-computer", tools: workerTurnTools("computer") },
];
const eventPolicies = [
  { suffix: "", tools: {} },
  { suffix: "-event-read-only", tools: EVENT_WRITE_DENY },
  { suffix: "-schedule-read-only", tools: EVENT_SCHEDULE_DENY },
];
const masks = new Map();
for (const base of bases) {
  const conclusions = base.id === "coworker-no-referral" || base.id === "coworker-group"
    ? [{ suffix: "", tools: {} }, { suffix: "-no-conclusion", tools: { coworker_event_conclude: false } }, { suffix: "-conclusion", tools: { coworker_event_conclude: true } }]
    : [{ suffix: "", tools: {} }];
  for (const policy of eventPolicies) for (const conclusion of conclusions) {
    const tools = { ...base.tools, ...policy.tools, ...conclusion.tools };
    const key = maskKey(tools);
    if (key !== "[]" && !masks.has(key)) masks.set(key, { id: base.id + policy.suffix + conclusion.suffix, tools });
  }
}
export const NATIVE_TURN_ROLES = Object.freeze([...masks.values()].map((role) => Object.freeze({
  ...role, tools: Object.freeze(role.tools), permissions: Object.freeze(nativePermissions(undefined, role.tools).map(Object.freeze)),
})));

function maskKey(tools) {
  if (tools === undefined || tools === null) return "[]";
  if (typeof tools !== "object" || Array.isArray(tools) || Reflect.ownKeys(tools).some((key) => typeof key !== "string")
    || (Object.getPrototypeOf(tools) !== Object.prototype && Object.getPrototypeOf(tools) !== null)
    || Object.values(tools).some((value) => typeof value !== "boolean")) throw new Error("Unsupported native turn tool mask.");
  return JSON.stringify(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b)));
}

/** Resolve before native admission. Unknown masks/custom masked bases fail closed.
 * Passing an already-pinned role without tools returns the identical role. */
export function nativeTurnAgent({ tools, agent = "build" } = {}) {
  if (typeof agent !== "string" || !agent.trim() || agent !== agent.trim()) throw new Error("A native turn agent is required.");
  const key = maskKey(tools);
  if (key === "[]") return agent;
  if (agent === NATIVE_COORDINATOR_AGENT && [COMPUTER_DENY, { ...COMPUTER_DENY, ...EVENT_WRITE_DENY }, { ...COMPUTER_DENY, ...EVENT_SCHEDULE_DENY }].some((mask) => key === maskKey(mask) || key === maskKey({ ...mask, coworker_react: false }))) return agent;
  const role = NATIVE_TURN_ROLES.find((role) => maskKey(role.tools) === key);
  if (!role || (agent !== "build" && agent !== role.id)) throw new Error("Unsupported native turn tool mask or conflicting agent pin.");
  return role.id;
}
