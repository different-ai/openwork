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
      if (shouldRerunAfterToolDecision(updated, choice)) onAllowed();
    },
  });
  if (request.kind !== "tool") return null;
  const name = agent.agent.name;
  const current = request.status === "pending" && decision.data?.id === request.id ? decision.data : request;
  const tool = requestToolTitle(current);
  const connection = requestConnectionName(current);

  if (current.status !== "pending") {
    const deniedByYou = decision.data?.id === current.id && decision.data.status === "denied"
      || agent.role === "owner" && current.decidedBy?.memberId === agent.agent.ownerMemberId;
    const receipt = toolRequestReceipt(current, name, deniedByYou);
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
  if (waiting) {
    return <p data-agent-ask={current.id} className="text-xs leading-relaxed text-dls-secondary">{waiting}</p>;
  }

  return (
    <ToolApprovalCard data-agent-ask={current.id}
      title={t("agents.permission_ask_title", { agent: name, tool, connection })}
      line={t("agents.permission_ask_accounts")}
      decisions={current.canDecide.filter((choice) => choice !== "approve")}
      busy={decision.isPending} onDecide={decide}>
      {agent.role === "owner" && !current.canDecide.includes("always_allow") && (
        <p className="mt-2 text-xs text-dls-secondary">{t("agents.permission_ask_admin")}</p>
      )}
    </ToolApprovalCard>
  );
}
