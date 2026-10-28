"use client";

import { ChevronRight } from "lucide-react";
import { useId } from "react";
import {
  AGENT_CORE_SOURCES,
  AGENT_CORE_SOURCE_COPY,
  AGENT_SOURCE_POLICIES,
  AGENT_SOURCE_POLICY_COPY,
  agentSourcePolicy,
  type AgentCoreSource,
  type AgentSourceConnection,
  type AgentSourcePolicy,
  type AgentSourcesPolicyInput,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { DenSelect } from "../../_components/ui/select";
import { ConnectorLogo } from "./item-logo";
import { SourceIcon } from "./source-icon";

/**
 * Manage › Workbot › What agents read: per source, on for everyone, members choose, or not allowed. Calendar, email and
 * team chat first, then every other connection behind one disclosure. The server enforces it for members' agents.
 */

function corePolicy(kind: AgentCoreSource, policy: AgentSourcePolicy): AgentSourcesPolicyInput {
  const change: AgentSourcesPolicyInput = {};
  change[kind] = policy;
  return change;
}

function policyFrom(value: string): AgentSourcePolicy | null {
  return AGENT_SOURCE_POLICIES.find((policy) => policy === value) ?? null;
}

function PolicySelect({ label, value, disabled, onChange }: { label: string; value: AgentSourcePolicy; disabled: boolean; onChange: (policy: AgentSourcePolicy) => void }) {
  return (
    <div className="w-44">
      <DenSelect aria-label={label} menuWidth="trigger" value={value} disabled={disabled}
        onChange={(event) => {
          const policy = policyFrom(event.target.value);
          if (policy) onChange(policy);
        }}>
        {AGENT_SOURCE_POLICIES.map((policy) => <option key={policy} value={policy}>{AGENT_SOURCE_POLICY_COPY[policy]}</option>)}
      </DenSelect>
    </div>
  );
}

/** "Google Calendar and Outlook calendar", or what is missing when the organization has nothing for it yet. */
function viaLabel(kind: AgentCoreSource, connections: readonly AgentSourceConnection[]) {
  const names = [...new Set(connections.map((connection) => connection.name))];
  if (!names.length) return `No ${AGENT_CORE_SOURCE_COPY[kind].label.toLowerCase()} connected`;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function SourceRow({ name, logo, state, testId, children }: { name: string; logo: React.ReactNode; state: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[56px] flex-wrap items-center justify-between gap-3 px-6 py-2.5" data-testid={testId}>
      <span className="flex min-w-0 items-center gap-3">
        {logo}
        <span className="text-[13px] font-medium text-gray-900">{name}</span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-3">
        <span className="text-[12px] text-gray-500">{state}</span>
        {children}
      </span>
    </div>
  );
}

export function WorkbotProactiveSources({ view, canManage, saving, onChange }: {
  view: WorkbotProactiveView;
  canManage: boolean;
  saving: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
}) {
  const headingId = useId();
  const locked = !canManage || saving;
  const { sources } = view.settings;
  const others = view.sourceConnections.other;

  return (
    <section aria-labelledby={headingId} className="grid gap-2" data-section="workbot-proactive-sources">
      <h2 id={headingId} className="px-1 text-[13px] font-medium text-gray-500">What agents read</h2>
      <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-sources">
        {AGENT_CORE_SOURCES.map((kind) => {
          const connections = view.sourceConnections[kind];
          const first = connections[0];
          return (
            <SourceRow key={kind} name={AGENT_CORE_SOURCE_COPY[kind].label} testId={`workbot-source-${kind}`} state={viaLabel(kind, connections)}
              logo={first ? <ConnectorLogo name={first.name} url={first.url} size="xs" /> : <SourceIcon kind={kind} />}>
              <PolicySelect label={AGENT_CORE_SOURCE_COPY[kind].label} value={sources[kind]} disabled={locked} onChange={(policy) => onChange({ sources: corePolicy(kind, policy) })} />
            </SourceRow>
          );
        })}
        <details className="group" data-testid="workbot-source-others">
          <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-1.5 px-6 text-[13px] font-medium text-gray-900 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-4 w-4 text-gray-500 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
            {`Other connections (${others.length})`}
          </summary>
          <div className="divide-y divide-gray-100 border-t border-gray-100">
            {others.length === 0 ? <p className="px-6 py-3 text-[13px] text-gray-500">No other connections yet.</p> : null}
            {others.map((connection) => (
              <SourceRow key={connection.id} name={connection.name} testId={`workbot-source-${connection.id}`} state=""
                logo={<ConnectorLogo name={connection.name} url={connection.url} size="xs" />}>
                <PolicySelect label={connection.name} value={agentSourcePolicy(sources, connection.id)} disabled={locked}
                  onChange={(policy) => onChange({ sources: { connections: { [connection.id]: policy } } })} />
              </SourceRow>
            ))}
          </div>
        </details>
        <p className="px-6 py-3 text-[12px] text-gray-500" data-testid="workbot-source-footer">Read only. Agents never send, edit or delete through these.</p>
      </div>
    </section>
  );
}
