import type { MessageWithParts } from "../types";
import { customAutoCompactionPolicies, resolveCustomAutoCompactionPolicyId } from "./auto-compaction-policy.custom";

export type AutoCompactionPolicyContext = {
  sessionID: string;
  previousStatus: string | null;
  status: string | null;
  messages: MessageWithParts[];
  lastAutoCompactedAt: number | null;
  now: number;
};

export type AutoCompactionPolicyDecision = {
  shouldCompact: boolean;
  estimatedTokens: number;
};

export type AutoCompactionPolicy = {
  id: string;
  shouldCompact: (context: AutoCompactionPolicyContext) => AutoCompactionPolicyDecision;
};

const DEFAULT_POLICY_ID = "token-threshold";
const DEFAULT_MIN_TOKENS = parsePositiveInt(import.meta.env?.VITE_OPENWORK_AUTO_COMPACTION_MIN_TOKENS, 100_000);
const DEFAULT_COOLDOWN_MS = parsePositiveInt(import.meta.env?.VITE_OPENWORK_AUTO_COMPACTION_COOLDOWN_MS, 60_000);

function parsePositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(typeof value === "string" ? value.trim() : "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function estimateSessionTokens(messages: MessageWithParts[]): number {
  return messages.reduce((sum, message) => {
    if (!("tokens" in message.info)) return sum;
    const tokens = message.info.tokens;
    if (!tokens) return sum;
    return sum + tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
  }, 0);
}

function isIdleTransition(context: AutoCompactionPolicyContext) {
  return context.status === "idle" && !!context.previousStatus && context.previousStatus !== "idle";
}

const idleAfterRunPolicy: AutoCompactionPolicy = {
  id: "idle-after-run",
  shouldCompact(context) {
    return {
      shouldCompact: isIdleTransition(context),
      estimatedTokens: estimateSessionTokens(context.messages),
    };
  },
};

const tokenThresholdPolicy: AutoCompactionPolicy = {
  id: DEFAULT_POLICY_ID,
  shouldCompact(context) {
    const estimatedTokens = estimateSessionTokens(context.messages);
    if (!isIdleTransition(context)) {
      return { shouldCompact: false, estimatedTokens };
    }
    if (estimatedTokens < DEFAULT_MIN_TOKENS) {
      return { shouldCompact: false, estimatedTokens };
    }
    if (context.lastAutoCompactedAt && context.now - context.lastAutoCompactedAt < DEFAULT_COOLDOWN_MS) {
      return { shouldCompact: false, estimatedTokens };
    }
    return { shouldCompact: true, estimatedTokens };
  },
};

const builtInPolicies: AutoCompactionPolicy[] = [tokenThresholdPolicy, idleAfterRunPolicy];

function allPolicies() {
  return [...builtInPolicies, ...customAutoCompactionPolicies];
}

function policyMap() {
  return new Map(allPolicies().map((policy) => [policy.id, policy]));
}

export function resolveAutoCompactionPolicyId() {
  const customPolicyId = resolveCustomAutoCompactionPolicyId({
    availablePolicies: allPolicies(),
    defaultPolicyId: DEFAULT_POLICY_ID,
  });
  const envPolicyId =
    typeof import.meta.env?.VITE_OPENWORK_AUTO_COMPACTION_POLICY === "string"
      ? import.meta.env.VITE_OPENWORK_AUTO_COMPACTION_POLICY.trim()
      : "";
  const desired = customPolicyId?.trim() || envPolicyId || DEFAULT_POLICY_ID;
  return policyMap().has(desired) ? desired : DEFAULT_POLICY_ID;
}

export function shouldAutoCompact(context: AutoCompactionPolicyContext): AutoCompactionPolicyDecision {
  const policy = policyMap().get(resolveAutoCompactionPolicyId()) ?? tokenThresholdPolicy;
  return policy.shouldCompact(context);
}
