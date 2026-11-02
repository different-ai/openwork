import {
  agentPermissionDenialMessage,
  agentPermissionRuleSchema,
  decideAgentPermission,
} from "@openwork/types/den/agent-permissions-runtime";

/** @typedef {import("@openwork/types/den/agent-permissions-runtime").AgentPermissionRule} AgentPermissionRule */
/** @typedef {{ effect: "allow" } | { effect: "ask", rule: AgentPermissionRule } | { effect: "deny", message: string }} ComputerDecision */

/**
 * The desktop's computer and scripting policy, independent of the app window.
 * Deny until a read succeeds, retrying unverified reads on the next check.
 * Later failed reads keep the last verified rules; a verified empty policy allows use.
 * @param {{ readRules: () => Promise<unknown>, confirm: (rule: AgentPermissionRule) => Promise<boolean>, now?: () => number }} options
 */
export function createComputerAgentPermissions({ readRules, confirm, now = Date.now }) {
  /** @type {AgentPermissionRule[]} */
  let rules = [];
  let signature = "[]";
  let revision = 0;
  let readAt = -Infinity;
  let verified = false;
  /** @type {Promise<void> | null} */
  let reading = null;
  /** @type {Set<string>} */
  const approved = new Set();
  /** @type {Map<string, Promise<boolean>>} */
  const pending = new Map();

  async function refresh() {
    if (reading) return reading;
    if (verified && now() - readAt < 30_000) return;
    readAt = now();
    reading = Promise.resolve().then(readRules).then((value) => {
      if (!Array.isArray(value)) throw new Error("Computer rules unavailable");
      const next = value.flatMap((entry) => {
        const parsed = agentPermissionRuleSchema.safeParse(entry);
        return parsed.success && ["computer", "script"].includes(parsed.data.action) ? [parsed.data] : [];
      });
      // Rule order is significant, but object property order is not.
      const nextSignature = JSON.stringify(next.map(({ action, resource, effect, source }) => [action, resource, effect, source]));
      if (nextSignature !== signature) {
        signature = nextSignature;
        revision++;
        approved.clear();
        pending.clear();
      }
      rules = next;
      verified = true;
    }).catch(() => { /* Keep the last known policy when the server cannot answer. */ }).finally(() => { reading = null; });
    return reading;
  }

  return {
    /**
     * @param {{ kind: "computer" | "script", sessionId?: string }} input
     * @returns {Promise<ComputerDecision>}
     */
    async check({ kind }) {
      await refresh();
      if (!verified) return { effect: "deny", message: "Your organization's agent permissions could not be verified yet. Try again in a moment; nothing ran." };
      const decision = decideAgentPermission(rules, kind, ["*"]);
      if (decision.effect === "deny" && decision.rule) return { effect: "deny", message: agentPermissionDenialMessage(decision.rule, decision.resource) };
      if (decision.effect === "ask" && decision.rule) return { effect: "ask", rule: decision.rule };
      return { effect: "allow" };
    },
    /**
     * One explicit approval per chat and policy. An old dialog cannot approve a new policy.
     * @param {string} sessionId
     * @param {AgentPermissionRule} rule
     * @returns {Promise<boolean>}
     */
    approveComputer(sessionId, rule) {
      if (!sessionId) return Promise.resolve(false);
      if (approved.has(sessionId)) return Promise.resolve(true);
      const existing = pending.get(sessionId);
      if (existing) return existing;
      const askedRevision = revision;
      const answer = Promise.resolve().then(() => confirm(rule)).then((value) => {
        if (value !== true || revision !== askedRevision) return false;
        approved.add(sessionId);
        return true;
      }).catch(() => false).finally(() => {
        if (pending.get(sessionId) === answer) pending.delete(sessionId);
      });
      pending.set(sessionId, answer);
      return answer;
    },
  };
}
