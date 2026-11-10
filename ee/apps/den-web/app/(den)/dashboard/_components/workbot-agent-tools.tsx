"use client";

import { ChevronRight, Lock } from "lucide-react";
import Link from "next/link";
import {
  AGENT_TOOL_DECISION_COPY,
  type AgentConnectionToolsView,
  type AgentSourcesPolicyInput,
  type AgentToolDecisionView,
} from "@openwork/types/den/workbot-proactive";
import { DenButton } from "../../_components/ui/button";
import { DenSwitch } from "../../_components/ui/switch";
import type { AgentPolicyScope } from "./workbot-agent-scope";
import { useAgentConnectionTools } from "./workbot-proactive-data";

/**
 * Manage › Workbot › What agents read, under one connection (`workbotAgentBrief`): "Tools agents may use: N read tools",
 * a disclosure (DESIGN.md S3) with one compact row per tool (S2): its name, why it is or isn't allowed, and a switch
 * for the admin's choice. A tool no admin can allow (its provider marks it destructive, or one of Den's own operations
 * that changes things) keeps its row with a lock and the reason (P4). Agents only ever call the allowed ones.
 * The same rows show a team's choices on its Workbot tab (`scope`).
 */

/** "3 read tools", "1 read tool", "No read tools". */
export function readToolsLine(count: number): string {
  if (count === 0) return "No read tools";
  return `${count} read tool${count === 1 ? "" : "s"}`;
}

/** The summary's state: how many tools agents may call, or why that isn't known. */
export function toolsSummary(view: AgentConnectionToolsView | undefined, failed: boolean, name: string): string {
  if (failed) return "Couldn't load its tools";
  if (!view) return "";
  if (view.status === "needs_connection") return `Connect ${name} to see its tools`;
  if (view.status === "unavailable") return `${name} didn't answer`;
  return readToolsLine(view.readTools);
}

/** The admin's choice for one tool, as a sources change: on is "allow", off is "deny". */
export function toolChoiceChange(connectionId: string, tool: string, allowed: boolean): AgentSourcesPolicyInput {
  return { toolOverrides: { [connectionId]: { [tool]: allowed ? "allow" : "deny" } } };
}

/** Back to the automatic decision for every tool on this connection. */
export function automaticToolsChange(connectionId: string): AgentSourcesPolicyInput {
  return { toolOverrides: { [connectionId]: null } };
}

function ToolRow({ tool, connectionId, disabled, onChange }: { tool: AgentToolDecisionView; connectionId: string; disabled: boolean; onChange: (change: AgentSourcesPolicyInput) => void }) {
  const label = tool.title && tool.title !== tool.name ? tool.title : tool.name;
  const reason = tool.locked ? `${AGENT_TOOL_DECISION_COPY[tool.reason]}. No one can allow it.` : AGENT_TOOL_DECISION_COPY[tool.reason];
  return (
    <div className="flex min-h-[40px] items-center justify-between gap-3 py-1.5 pl-20 pr-6" data-testid={`workbot-agent-tool-${tool.name}`} data-allowed={tool.allowed} data-locked={tool.locked}>
      <span className="min-w-0 truncate font-mono text-[12px] text-gray-900" title={tool.description ?? undefined}>{label}</span>
      <span className="flex min-w-0 shrink-0 items-center gap-3">
        <span className="truncate text-[12px] text-gray-500">{reason}</span>
        {tool.locked ? (
          <span className="flex h-5 w-9 items-center justify-center">
            <Lock size={14} strokeWidth={1.5} className="text-gray-500" role="img" aria-label={`${tool.name}: ${reason}`} />
          </span>
        ) : (
          <DenSwitch size="sm" aria-label={`Agents may use ${tool.name}`} checked={tool.allowed} disabled={disabled}
            onChange={(allowed) => onChange(toolChoiceChange(connectionId, tool.name, allowed))} />
        )}
      </span>
    </div>
  );
}

/** The tools of one connection, behind a disclosure. Listed once, when the row mounts, so the summary has its count. */
export function AgentConnectionTools({ orgId, scope, connectionId, name, connectHref, disabled, onChange }: {
  orgId: string;
  /** Whose choices: Everyone's, or one team's. */
  scope?: AgentPolicyScope;
  connectionId: string;
  name: string;
  connectHref: string;
  disabled: boolean;
  onChange: (change: AgentSourcesPolicyInput) => void;
}) {
  const query = useAgentConnectionTools(orgId, connectionId, true, scope);
  return <ConnectionToolsDisclosure view={query.data} failed={query.isError} name={name} connectionId={connectionId} connectHref={connectHref} disabled={disabled} onChange={onChange} />;
}

/** The disclosure itself, from a loaded view (rendered without fetching in tests and screenshots). */
export function ConnectionToolsDisclosure({ view, failed, name, connectionId, connectHref, disabled, onChange }: {
  view: AgentConnectionToolsView | undefined;
  failed: boolean;
  name: string;
  connectionId: string;
  connectHref: string;
  disabled: boolean;
  onChange: (change: AgentSourcesPolicyInput) => void;
}) {
  const state = toolsSummary(view, failed, name);
  const chosen = view?.tools.some((tool) => tool.override !== null) ?? false;
  return (
    <details className="group/tools" data-testid={`workbot-agent-tools-${connectionId}`} data-read-tools={view?.readTools ?? ""}>
      <summary className="flex min-h-[36px] cursor-pointer list-none items-center justify-between gap-3 py-1.5 pl-14 pr-6 text-[12px] text-gray-500 outline-hidden hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-900/5 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight size={14} strokeWidth={1.5} aria-hidden className="shrink-0 transition-transform duration-150 group-open/tools:rotate-90 motion-reduce:transition-none" />
          <span className="truncate">{`Tools agents may use${state ? `: ${state}` : ""}`}</span>
        </span>
        <span className="shrink-0 font-medium text-gray-700 group-open/tools:hidden">Review</span>
      </summary>
      <div className="pb-1" data-testid={`workbot-agent-tools-list-${connectionId}`}>
        {view?.status === "needs_connection" ? (
          <p className="py-2 pl-20 pr-6 text-[12px] text-gray-500">
            <Link href={connectHref} className="font-medium text-gray-900 underline-offset-2 hover:underline">{`Connect ${name}`}</Link>
            {" to see its tools."}
          </p>
        ) : null}
        {view?.status === "ready" && view.tools.length === 0 ? <p className="py-2 pl-20 pr-6 text-[12px] text-gray-500">It lists no tools.</p> : null}
        {view?.status === "ready" ? view.tools.map((tool) => <ToolRow key={tool.name} tool={tool} connectionId={connectionId} disabled={disabled} onChange={onChange} />) : null}
        {view?.coreSourcesElsewhere ? <p className="py-2 pl-20 pr-6 text-[12px] text-gray-500">Calendar, mail and chat are read under their own sources.</p> : null}
        {chosen ? (
          <div className="flex justify-end py-1.5 pr-6">
            <DenButton variant="ghost" size="xs" disabled={disabled} onClick={() => onChange(automaticToolsChange(connectionId))}>Use automatic choices</DenButton>
          </div>
        ) : null}
      </div>
    </details>
  );
}
