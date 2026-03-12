import type { MessageWithParts, ProviderListItem } from "../types";
import { customAutoCompactionPolicies, resolveCustomAutoCompactionPolicyId } from "./auto-compaction-policy.custom";

type AssistantMessageWithTokens = MessageWithParts["info"] & {
  role: "assistant";
  providerID: string;
  modelID: string;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
};

export type AutoCompactionPolicyContext = {
  sessionID: string;
  previousStatus: string | null;
  status: string | null;
  messages: MessageWithParts[];
  providers: ProviderListItem[];
  lastAutoCompactedAt: number | null;
  now: number;
};

export type AutoCompactionPolicyDecision = {
  shouldCompact: boolean;
  usagePercent: number | null;
};

export type AutoCompactionPolicy = {
  id: string;
  shouldCompact: (context: AutoCompactionPolicyContext) => AutoCompactionPolicyDecision;
};

const DEFAULT_POLICY_ID = "context-percent";
const DEFAULT_MIN_CONTEXT_PERCENT = parsePositiveInt(
  import.meta.env?.VITE_OPENWORK_AUTO_COMPACTION_MIN_CONTEXT_PERCENT,
  50,
);
const DEFAULT_COOLDOWN_MS = parsePositiveInt(import.meta.env?.VITE_OPENWORK_AUTO_COMPACTION_COOLDOWN_MS, 60_000);

function parsePositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(typeof value === "string" ? value.trim() : "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function lastAssistantWithTokens(messages: MessageWithParts[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.info.role !== "assistant") continue;
    if (!("tokens" in candidate.info) || !("providerID" in candidate.info) || !("modelID" in candidate.info)) {
      continue;
    }
    const info = candidate.info as AssistantMessageWithTokens;
    const total =
      info.tokens.input +
      info.tokens.output +
      info.tokens.reasoning +
      info.tokens.cache.read +
      info.tokens.cache.write;
    if (total <= 0) continue;
    return info;
  }
}

function contextUsagePercent(context: AutoCompactionPolicyContext) {
  const message = lastAssistantWithTokens(context.messages);
  if (!message) return null;
  const provider = context.providers.find((item) => item.id === message.providerID);
  const model = provider?.models?.[message.modelID];
  const limit = model?.limit?.context;
  if (!limit || limit <= 0) return null;
  const total =
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    message.tokens.cache.read +
    message.tokens.cache.write;
  return Math.round((total / limit) * 100);
}

function isIdleTransition(context: AutoCompactionPolicyContext) {
  return context.status === "idle" && !!context.previousStatus && context.previousStatus !== "idle";
}

const idleAfterRunPolicy: AutoCompactionPolicy = {
  id: "idle-after-run",
  shouldCompact(context) {
    return {
      shouldCompact: isIdleTransition(context),
      usagePercent: contextUsagePercent(context),
    };
  },
};

const contextPercentPolicy: AutoCompactionPolicy = {
  id: "context-percent",
  shouldCompact(context) {
    const usagePercent = contextUsagePercent(context);
    if (!isIdleTransition(context)) {
      return { shouldCompact: false, usagePercent };
    }
    if (usagePercent === null || usagePercent < DEFAULT_MIN_CONTEXT_PERCENT) {
      return { shouldCompact: false, usagePercent };
    }
    if (context.lastAutoCompactedAt && context.now - context.lastAutoCompactedAt < DEFAULT_COOLDOWN_MS) {
      return { shouldCompact: false, usagePercent };
    }
    return { shouldCompact: true, usagePercent };
  },
};

const builtInPolicies: AutoCompactionPolicy[] = [contextPercentPolicy, idleAfterRunPolicy];

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
  const policy = policyMap().get(resolveAutoCompactionPolicyId()) ?? contextPercentPolicy;
  return policy.shouldCompact(context);
}
