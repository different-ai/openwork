import type { PersonalAgentDetail, PersonalAgentRequest, PersonalAgentRequestDecision } from "@openwork/types/den/personal-agents";
import { ShieldCheck, ShieldX } from "lucide-react";

import { ToolApprovalCard } from "@/react-app/design-system/tool-approval-card";
import { t } from "@/i18n";

import { requestConnectionName, requestToolTitle, shouldRerunAfterToolDecision, toolRequestReceipt, toolRequestRerunLine, toolRequestWaitingLine } from "./agent-permission-words";
import type { AgentsRuntime } from "./agents-runtime";
import { useDecideAgentToolRequest } from "./use-agent-permissions";

export function AgentAskCard({ runtime, agent, request, onAllowed }: {
  runtime: AgentsRuntime;
  agent: PersonalAgentDetail;
  request: PersonalAgentRequest;
  onAllowed: () => void;
}) {
  const decision = useDecideAgentToolRequest(runtime, agent.agent.id, request.id);
  const decide = (choice: Exclude<PersonalAgentRequestDecision, "approve">) => decision.mutate(choice, {
    onSuccess: (updated) => {
      if (updated.runId && (choice === "turn_on" ? updated.status === "always_allowed" && updated.requestedByCaller : shouldRerunAfterToolDecision(updated, choice))) onAllowed();
    },
  });
  if (request.kind !== "tool") return null;
  const name = agent.agent.name;
  const awaitingDecision = request.status === "pending" || request.status === "awaiting_owner";
  const current = awaitingDecision && decision.data?.id === request.id && (request.status === "pending" || decision.data.status !== "awaiting_owner") ? decision.data : request;
  const connectorAccess = current.connectorAccess === true;
  const tool = requestToolTitle(current);
  const connection = requestConnectionName(current);

  if (current.status !== "pending" && current.status !== "awaiting_owner") {
    const deniedByYou = decision.data?.id === current.id && decision.data.status === "denied"
      || agent.role === "owner" && current.decidedBy?.memberId === agent.agent.ownerMemberId;
    const receipt = connectorAccess && current.status === "always_allowed"
      ? t("agents.connector_ask_enabled", { connection, agent: name })
      : toolRequestReceipt(current.toolName || !connectorAccess ? current : { ...current, toolTitle: connection }, name, deniedByYou);
    if (!receipt) return null;
    const Shield = current.status === "denied" ? ShieldX : ShieldCheck;
    const rerunLine = agent.role === "collaborator" ? null : toolRequestRerunLine(current);
    return (
      <div data-agent-ask={current.id} data-agent-ask-receipt={current.status} className="text-xs leading-relaxed text-dls-secondary">
        <p className="flex items-baseline gap-1.5">
          <Shield aria-hidden="true" className="relative top-0.5 size-3.5 shrink-0" />
          {receipt}
        </p>
        {rerunLine ? <p className="ps-5">{rerunLine}</p> : null}
      </div>
    );
  }
  const waiting = toolRequestWaitingLine(current, agent.owner);
  if (current.status === "awaiting_owner" && current.canDecide.length === 0) {
    return <p data-agent-ask={current.id} role="status" className="text-xs leading-relaxed text-dls-secondary">{t("agents.connector_ask_waiting", { connection })}</p>;
  }
  if (waiting) {
    return <p data-agent-ask={current.id} className="text-xs leading-relaxed text-dls-secondary">{waiting}</p>;
  }

  return (
    <ToolApprovalCard data-agent-ask={current.id}
      title={connectorAccess
        ? (current.toolName ? t("agents.connector_ask_tool_title", { agent: name, tool, connection }) : t("agents.connector_ask_title", { agent: name, connection }))
        : t("agents.permission_ask_title", { agent: name, tool, connection })}
      line={connectorAccess ? t("agents.connector_ask_line") : t("agents.permission_ask_accounts")}
      decisions={current.canDecide.filter((choice) => choice !== "approve" && choice !== "turn_on")}
      turnOn={connectorAccess && current.canDecide.includes("turn_on") ? {
        label: t(agent.role === "manager" ? "agents.connector_ask_request_on" : "agents.connector_ask_turn_on", { connection }),
        run: () => decide("turn_on"),
      } : undefined}
      busy={decision.isPending} onDecide={decide}>
      {decision.isError && <p role="alert" className="mt-2 text-xs text-dls-secondary">{t("agents.connector_ask_decision_failed")}</p>}
      {!connectorAccess && agent.role === "owner" && !current.canDecide.includes("always_allow") && (
        <p className="mt-2 text-xs text-dls-secondary">{t("agents.permission_ask_admin")}</p>
      )}
    </ToolApprovalCard>
  );
}
