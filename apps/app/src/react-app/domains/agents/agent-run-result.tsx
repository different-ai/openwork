import type { AutomationRun } from "@openwork/types/automations";

import { t } from "@/i18n";
import { AutomationRunTranscript } from "@/react-app/design-system/automation-run-transcript";
import { automationRunMessages } from "@/react-app/kernel/automation-run-messages";

import type { AgentsRuntime } from "./agents-runtime";
import { timeOfDay } from "./agent-words";
import { isActiveRun, useAgentRunQuery } from "./use-agents";

function resultText(run: AutomationRun, routineName: string): string {
  if (run.status === "succeeded") return run.resultSummary?.trim() || t("agents.run_empty", { name: routineName });
  return t("agents.run_failed", { name: routineName, reason: run.error?.message.trim() || run.status });
}

export function AgentScheduledRunSummary({ run, routineName }: { run: Pick<AutomationRun, "id" | "status" | "resultSummary" | "finishedAt">; routineName: string }) {
  const active = isActiveRun(run);
  const text = active ? t("agents.run_working", { name: routineName })
    : run.resultSummary?.trim() || (run.status === "succeeded" ? t("agents.run_empty", { name: routineName }) : t("agents.run_not_finished", { name: routineName }));
  return (
    <div data-agent-run={run.id} data-agent-run-state={run.status} data-agent-run-summary className="flex flex-col gap-1.5">
      <p data-agent-line className={active ? "motion-safe:animate-pulse text-[13px] leading-relaxed text-dls-secondary" : "whitespace-pre-wrap text-[13px] leading-relaxed text-foreground"}>{text}</p>
      <p className="text-xs text-dls-secondary">
        {[t("agents.run_scheduled"), routineName, run.finishedAt !== null ? timeOfDay(run.finishedAt) : null].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}

export function AgentRunResult(props: { runtime: AgentsRuntime; agentId: string; runId: string; routineName: string; active?: boolean }) {
  const query = useAgentRunQuery(props.runtime, props.agentId, props.runId, props.active ?? true);
  const receipt = query.data;
  if (query.isError && !receipt) {
    return <p data-agent-run={props.runId} data-agent-run-state="unavailable" data-agent-line className="text-[13px] leading-relaxed text-dls-secondary">{t("agents.run_unavailable", { name: props.routineName })}</p>;
  }
  const running = Boolean(receipt && isActiveRun(receipt.run));
  const messages = receipt ? automationRunMessages(receipt) : [];
  if (!receipt || (running && messages.length === 0)) {
    return (
      <p data-agent-run={props.runId} data-agent-run-state="working" data-agent-line className="motion-safe:animate-pulse text-[13px] leading-relaxed text-dls-secondary">
        {t("agents.run_working", { name: props.routineName })}
      </p>
    );
  }
  const { run } = receipt;
  const scope = JSON.stringify([props.runtime.denBaseUrl, props.runtime.organizationId, props.runtime.principal, props.agentId, run.id]);
  const showResult = !running && (run.status !== "succeeded" || messages.length === 0);
  return (
    <div data-agent-run={props.runId} data-agent-run-state={running ? "working" : run.status} className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs text-dls-secondary">
        {running ? t("agents.run_working", { name: props.routineName }) : [props.routineName, timeOfDay(run.finishedAt ?? run.updatedAt)].join(" · ")}
      </p>
      {messages.length > 0 && <div data-agent-line><AutomationRunTranscript scope={scope} running={running} messages={messages} /></div>}
      {showResult && <p data-agent-line className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{resultText(run, props.routineName)}</p>}
    </div>
  );
}
