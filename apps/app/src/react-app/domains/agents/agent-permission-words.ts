import type { PersonalAgentConnectionTools, PersonalAgentPerson, PersonalAgentRequest, PersonalAgentRequestDecision, PersonalAgentSpend, PersonalAgentTool } from "@openwork/types/den/personal-agents";

import { currentLocale, t } from "@/i18n";

import { firstName } from "./agent-words";

export function toolControlState(tool: Pick<PersonalAgentTool, "access" | "chosen" | "lockedByOrganization" | "organizationRule">, connectionBlocked = false) {
  if (tool.lockedByOrganization || connectionBlocked) return { access: tool.access, allowDisabled: true, hint: null };
  if (tool.organizationRule === "ask") {
    return { access: tool.access === "block" ? "block" : "ask", allowDisabled: true, hint: t("agents.permissions_admin_ask") } as const;
  }
  if (tool.organizationRule === "allow" && tool.chosen === null) {
    return { access: "allow", allowDisabled: false, hint: t("agents.permissions_admin_allow") } as const;
  }
  return { access: tool.access, allowDisabled: false, hint: null };
}

export function toolAccessSummary(connection: Pick<PersonalAgentConnectionTools, "available" | "blocked" | "lockedByOrganization" | "tools">): string {
  if (connection.lockedByOrganization) return t("agents.permissions_admin_blocked");
  if (connection.blocked) return t("agents.permissions_connection_off");
  if (!connection.available) return t("agents.permissions_not_connected");
  const counts = { allow: 0, ask: 0, block: 0 };
  for (const tool of connection.tools) counts[tool.access] += 1;
  return t("agents.permissions_counts", counts);
}

export function agentOwnerFirstName(owner: PersonalAgentPerson | null): string {
  return owner?.name.trim().split(/\s+/)[0] || t("agents.permissions_owner");
}

export function requestToolTitle(request: Pick<PersonalAgentRequest, "toolTitle" | "toolName">): string {
  const title = request.toolTitle?.trim();
  const name = request.toolName?.trim();
  if (title && title !== name) return title;
  const words = name?.split(/[:./]/u).at(-1)?.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : t("agents.permission_ask_tool");
}

export function requestConnectionName(request: Pick<PersonalAgentRequest, "connectionName">): string {
  return request.connectionName?.trim() || t("agents.permission_ask_connection");
}

export function toolRequestWaitingLine(
  request: Pick<PersonalAgentRequest, "status" | "canDecide" | "toolTitle" | "toolName" | "connectionName">,
  owner: PersonalAgentPerson | null,
): string | null {
  if (request.status !== "pending" || request.canDecide.length > 0) return null;
  return t("agents.permission_ask_waiting", {
    owner: agentOwnerFirstName(owner), tool: requestToolTitle(request), connection: requestConnectionName(request),
  });
}

export function toolRequestReceipt(
  request: Pick<PersonalAgentRequest, "status" | "toolTitle" | "toolName" | "decidedBy">,
  agentName: string,
  decidedByYou = false,
): string | null {
  const tool = requestToolTitle(request);
  switch (request.status) {
    case "denied":
      return t("agents.permission_ask_denied", {
        decider: (!decidedByYou && request.decidedBy?.name.trim()) || t("agents.permission_ask_you"),
        agent: agentName,
        tool,
      });
    case "allowed_once":
    case "used":
      return t("agents.permission_ask_once_receipt", { agent: agentName, tool });
    case "always_allowed":
      return t("agents.permission_ask_always_receipt", { agent: agentName, tool });
    default:
      return null;
  }
}

export function shouldRerunAfterToolDecision(request: Pick<PersonalAgentRequest, "requestedByCaller">, decision: PersonalAgentRequestDecision): boolean {
  return request.requestedByCaller === true && (decision === "allow_once" || decision === "always_allow");
}

export function toolRequestRerunLine(request: Pick<PersonalAgentRequest, "requestedByCaller" | "requestedBy" | "status">): string | null {
  if (request.requestedByCaller || (request.status !== "allowed_once" && request.status !== "always_allowed")) return null;
  return t("agents.permission_ask_requester_can_run", { name: firstName(request.requestedBy.name) || t("agents.permission_ask_requester") });
}

export function formatAgentMoney(micros: number, fractionDigits = 2): string {
  return new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(micros / 1_000_000);
}

export function agentSpendLine(spend: Pick<PersonalAgentSpend, "monthMicros" | "budgetMicros">): string {
  const amount = formatAgentMoney(spend.monthMicros);
  return spend.budgetMicros === null
    ? t("agents.permissions_spend_month", { amount })
    : t("agents.permissions_spend_limit", { amount, limit: formatAgentMoney(spend.budgetMicros) });
}
