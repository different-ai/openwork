import type { PersonalAgentDetail, PersonalAgentRequest } from "@openwork/types/den/personal-agents";
import { ShieldCheck, ShieldX } from "lucide-react";

import { t } from "@/i18n";
import { ToolApprovalCard } from "@/react-app/design-system/tool-approval-card";

import { requestConnectionName, requestToolTitle, shouldRerunAfterToolDecision, toolRequestReceipt, toolRequestRerunLine, toolRequestWaitingLine } from "./agent-permission-words";
import type { AgentsRuntime } from "./agents-runtime";
import { useDecideAgentToolRequest } from "./use-agent-permissions";

export function isVisibleAgentRequest(agent: PersonalAgentDetail, request: PersonalAgentRequest): boolean {
  if (request.kind !== "tool" || request.status !== "pending" || !request.connectionId || !request.toolName) return true;
  return agent.revision.toolPolicy.tools[request.connectionId]?.[request.toolName] !== "block";
}

export function canDecideAgentToolRequest(request: PersonalAgentRequest): boolean {
  return request.kind === "tool" && (request.status === "pending" || request.status === "awaiting_owner")
    && request.canDecide.some((choice) => choice !== "approve");
}

export function AgentToolDecision({ runtime, agent, request, onAllowed }: {
  runtime: AgentsRuntime;
  agent: PersonalAgentDetail;
  request: PersonalAgentRequest;
  onAllowed?: () => void;
}) {
  const decision = useDecideAgentToolRequest(runtime, agent.agent.id, request.id, (updated, choice) => {
    if (updated.runId && (choice === "turn_on" ? updated.status === "always_allowed" && updated.requestedByCaller : shouldRerunAfterToolDecision(updated, choice))) onAllowed?.();
  });
  const name = agent.agent.name;
  const connectorAccess = request.connectorAccess === true;
  const tool = requestToolTitle(request);
  const connection = requestConnectionName(request);

  return (
    <ToolApprovalCard data-agent-ask={request.id}
      variant="inline"
      title={connectorAccess
        ? (request.toolName ? t("agents.connector_ask_tool_title", { agent: name, tool, connection }) : t("agents.connector_ask_title", { agent: name, connection }))
        : t("agents.permission_ask_title", { agent: name, tool, connection })}
      line={connectorAccess ? t(request.toolName ? "agents.connector_ask_tool_line" : "agents.connector_ask_line", { connection }) : t("agents.permission_ask_accounts")}
      decisions={request.canDecide.filter((choice) => choice !== "approve" && choice !== "turn_on")}
      turnOn={connectorAccess && request.canDecide.includes("turn_on") ? {
        label: t(agent.role === "manager" ? "agents.connector_ask_request_on" : "agents.connector_ask_turn_on", { connection }),
        run: () => decision.mutate("turn_on"),
      } : undefined}
      busy={decision.isPending} onDecide={(choice) => decision.mutate(choice)}>
      {decision.isError && <p role="alert" className="mt-2 text-xs text-dls-secondary">{t("agents.connector_ask_decision_failed")}</p>}
      {!connectorAccess && agent.role === "owner" && !request.canDecide.includes("always_allow") && (
        <p className="mt-2 text-xs text-dls-secondary">{t("agents.permission_ask_admin")}</p>
      )}
    </ToolApprovalCard>
  );
}

export function AgentToolReceipt({ agent, request }: { agent: PersonalAgentDetail; request: PersonalAgentRequest }) {
  const connection = requestConnectionName(request);
  if (request.status === "awaiting_owner") {
    return <p data-agent-ask={request.id} role="status" className="text-xs leading-relaxed text-dls-secondary">{t("agents.connector_ask_waiting", { connection })}</p>;
  }
  if (request.status === "pending") {
    const waiting = toolRequestWaitingLine(request, agent.owner);
    return waiting ? <p data-agent-ask={request.id} className="text-xs leading-relaxed text-dls-secondary">{waiting}</p> : null;
  }
  const name = agent.agent.name;
  const connectorAccess = request.connectorAccess === true;
  const deniedByYou = agent.role === "owner" && request.decidedBy?.memberId === agent.agent.ownerMemberId;
  const receipt = connectorAccess && request.status === "always_allowed" && (!request.toolName || (request.connectionId !== null && agent.revision.toolPolicy.connections[request.connectionId] === "allow"))
    ? t("agents.connector_ask_enabled", { connection, agent: name })
    : toolRequestReceipt(request.toolName || !connectorAccess ? request : { ...request, toolTitle: connection }, name, deniedByYou);
  if (!receipt) return null;
  const Shield = request.status === "denied" ? ShieldX : ShieldCheck;
  const next = agent.role === "collaborator" ? null : request.runId ? toolRequestRerunLine(request)
    : request.requestedByCaller && (request.status === "allowed_once" || request.status === "always_allowed")
      ? t("agents.chat_permission_next") : null;
  return (
    <div data-agent-ask={request.id} data-agent-ask-receipt={request.status} className="text-xs leading-relaxed text-dls-secondary">
      <p className="flex items-baseline gap-1.5">
        <Shield aria-hidden="true" className="relative top-0.5 size-3.5 shrink-0" />
        {receipt}
      </p>
      {next && <p className="ps-5">{next}</p>}
    </div>
  );
}
