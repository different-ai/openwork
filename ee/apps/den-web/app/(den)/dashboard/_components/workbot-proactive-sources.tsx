"use client";

import { Lock, Plus, Search } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
  AGENT_CORE_SOURCE_COPY,
  AGENT_SOURCE_POLICIES,
  AGENT_SOURCE_POLICY_COPY,
  agentOtherConnections,
  agentSourcePolicy,
  type AgentOtherSourceConnection,
  type AgentSourceOption,
  type AgentSourcePolicy,
  type AgentSourcesPolicyInput,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { permissionLockReason } from "../../_lib/den-org";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenDropdownPopup, DenDropdownRoot, DenDropdownTrigger } from "../../_components/ui/dropdown-popup";
import { denDropdownListClass, denDropdownRowBaseClass, denDropdownRowIdleClass } from "../../_components/ui/dropdown-styles";
import { DenSelect } from "../../_components/ui/select";
import { ConnectorLogo } from "./item-logo";
import type { AgentPolicyScope } from "./workbot-agent-scope";
import { AgentConnectionToolsButton } from "./workbot-agent-tools";

/**
 * What members' agents read. The calendar is one setting on General (`AgentCalendarPolicy`): on for everyone, members
 * choose, or not allowed. It is read through whichever calendar app the organization connected, with nothing to pick.
 * Everything else is a connector (the Connectors tab, `WorkbotProactiveSources`): each connection the organization has,
 * under its own setting. Mail and chat are read through the Google Workspace, Microsoft 365 or Slack connector. The
 * server enforces all of it for members' agents.
 *
 * With Your agent's brief on (`view.brief`), every connection can be listed with no count cap, each under its policy,
 * and each has "Tools agents may use" (workbot-agent-tools.tsx).
 */

type SourcesView = Pick<WorkbotProactiveView, "settings" | "sourceConnections">;

/** The connections agents read now, before Your agent's brief: the admin's list, or every one with reviewed read tools. */
export function listedConnections(view: SourcesView): AgentSourceOption[] {
  const all = view.sourceConnections?.all ?? [];
  const ids = agentOtherConnections(view.settings.sources) ?? view.sourceConnections?.other.map((connection) => connection.id) ?? [];
  return ids.flatMap((id) => all.filter((option) => option.id === id));
}

/** "Uses Google Workspace", "Uses Google Workspace or Microsoft 365", "No calendar app connected". */
export function calendarStateLine(view: SourcesView): string {
  if (view.settings.sources.calendar === "off") return "Agents don't read it";
  if (!view.sourceConnections) return `Uses ${AGENT_CORE_SOURCE_COPY.calendar.via}`;
  const names = view.sourceConnections.calendar.map((connection) => connection.name);
  if (names.length === 0) return "No calendar app connected";
  if (names.length === 1) return `Uses ${names[0]}`;
  return `Uses ${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * The policy a connector has now (every connection listed): the admin's saved choice, else the server's (a reviewed
 * connection an admin removed before every connection was listed stays not allowed), else members choose.
 */
export function otherPolicy(view: SourcesView, option: AgentOtherSourceConnection): AgentSourcePolicy {
  return view.settings.sources.connections[option.id] ?? option.policy ?? "members";
}

/**
 * In a tab, Connectors lists only the connections an admin set (or the server holds back), not every connection: the
 * rest are up to each member, and "Add connector" brings one into the list.
 */
export function otherConnectionAdded(view: SourcesView, option: AgentOtherSourceConnection): boolean {
  return view.settings.sources.connections[option.id] !== undefined || (option.policy ?? "members") !== "members";
}

/** "58 other connections are up to each member.", "1 other connection is up to each member." */
export function otherConnectionsRestLine(count: number): string {
  return count === 1 ? "1 other connection is up to each member." : `${count} other connections are up to each member.`;
}

/** "12 connections", "1 connection". */
export function connectionCount(count: number): string {
  return `${count} connection${count === 1 ? "" : "s"}`;
}

/** Connections that can still be added, before Your agent's brief: the ones agents can read that aren't listed yet. */
export function addableConnections(view: SourcesView): AgentSourceOption[] {
  const here = new Set(listedConnections(view).map((option) => option.id));
  return (view.sourceConnections?.all ?? []).filter((option) => option.slots.includes("other") && !here.has(option.id));
}

/** Adds a connection to the ones agents read. */
export function addConnectionChange(view: SourcesView, connectionId: string): AgentSourcesPolicyInput {
  return { otherConnections: [...listedConnections(view).map((option) => option.id), connectionId] };
}

/** Takes a connection out of the ones agents read, and clears its setting. */
export function removeConnectionChange(view: SourcesView, connectionId: string): AgentSourcesPolicyInput {
  return { otherConnections: listedConnections(view).map((option) => option.id).filter((id) => id !== connectionId), connections: { [connectionId]: null } };
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

/** Connectors shows a filter once the list is longer than this. */
const FILTER_FROM = 8;

/** The connections whose name contains what was typed, ignoring case. */
export function filterConnections<T extends { name: string }>(connections: readonly T[], typed: string): T[] {
  const query = typed.trim().toLowerCase();
  return query ? connections.filter((connection) => connection.name.toLowerCase().includes(query)) : [...connections];
}

function AddConnector<Option extends Pick<AgentSourceOption, "id" | "name" | "url">>({ options, disabled, onPick }: {
  options: Option[];
  disabled: boolean;
  onPick: (option: Option) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // A long list gets a box to find one by name.
  const searchable = options.length > FILTER_FROM;
  const shown = searchable ? filterConnections(options, query) : options;
  return (
    <DenDropdownRoot open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <DenDropdownTrigger ref={triggerRef} type="button" disabled={disabled} aria-label="Add connector"
        data-testid="workbot-source-add-other"
        className="flex min-h-[40px] items-center gap-2 rounded-lg pl-14 pr-6 text-left text-[13px] font-medium text-gray-700 outline-hidden hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-900/5 disabled:cursor-not-allowed disabled:opacity-60">
        <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
        Add connector
      </DenDropdownTrigger>
      {open ? (
        <DenDropdownPopup anchor={triggerRef} popupRef={popupRef}>
          {searchable ? (
            <div className="border-b border-gray-100 p-2">
              <DenInput type="search" icon={Search} autoFocus aria-label="Find a connection" placeholder="Find a connection" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
          ) : null}
          <div className={denDropdownListClass} role="menu" aria-label="Connectors to add">
            {options.length === 0 ? <p className="max-w-[280px] px-3 py-2.5 text-[13px] leading-5 text-gray-500">Every connector is already here.</p> : null}
            {options.length > 0 && shown.length === 0 ? <p className="px-3 py-2.5 text-[13px] text-gray-500">No connections match</p> : null}
            {shown.map((option) => (
              <button key={option.id} type="button" role="menuitem" aria-label={option.name} className={`${denDropdownRowBaseClass} ${denDropdownRowIdleClass} items-center justify-start`}
                onClick={() => {
                  setOpen(false);
                  onPick(option);
                }}>
                <ConnectorLogo name={option.name} url={option.url} size="xs" />
                <span className="truncate text-[13px] text-gray-900">{option.name}</span>
              </button>
            ))}
          </div>
        </DenDropdownPopup>
      ) : null}
    </DenDropdownRoot>
  );
}

/**
 * The calendar's one control, for the Calendar row on General: on for everyone, members choose, or not allowed. Which
 * calendar app is read is automatic, so there is nothing else to set.
 */
export function AgentCalendarPolicy({ view, disabled, onChange }: {
  view: SourcesView;
  disabled: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
}) {
  return (
    <span data-testid="workbot-source-calendar" data-policy={view.settings.sources.calendar}>
      <PolicySelect label={AGENT_CORE_SOURCE_COPY.calendar.label} value={view.settings.sources.calendar} disabled={disabled}
        onChange={(calendar) => onChange({ sources: { calendar } })} />
    </span>
  );
}

export function WorkbotProactiveSources({ view, canManage, saving, onChange, tools, heading = true }: {
  /** False where the tab around it already says "Connectors". */
  heading?: boolean;
  view: WorkbotProactiveView;
  canManage: boolean;
  saving: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
  /** With the brief on: where to list each connection's tools (under Everyone's policy, or `scope`'s) and connect one. */
  tools?: { orgId: string; scope?: AgentPolicyScope; connectorHref: (connectionId: string) => string };
}) {
  const headingId = useId();
  const [filter, setFilter] = useState("");
  const locked = !canManage || saving;
  const { sources } = view.settings;
  const connections = view.sourceConnections;
  // Your agent's brief: any connected connector can be a source, each tool decided read or not.
  const anyConnector = view.brief !== undefined;

  const save = (change: AgentSourcesPolicyInput) => onChange({ sources: change });
  // A connection's tools open from a button on its row.
  const toolsButtonOf = (option: { id: string; name: string }) => tools && anyConnector ? (
    <AgentConnectionToolsButton orgId={tools.orgId} scope={tools.scope} connectionId={option.id} name={option.name} connectHref={tools.connectorHref(option.id)} disabled={locked} onChange={save} />
  ) : null;

  // With the brief: every connection, each with its policy and its tools.
  const everyConnectionRows = () => {
    const everything = connections?.other ?? [];
    // In a tab: only the connections that were added; the rest are behind "Add connector".
    const all = everything.filter((option) => otherConnectionAdded(view, option));
    const rest = everything.filter((option) => !otherConnectionAdded(view, option));
    const filtering = all.length > FILTER_FROM;
    const every = filtering ? filterConnections(all, filter) : all;
    return (
      <>
        {filtering ? (
          <div className="px-6 py-2">
            <DenInput type="search" icon={Search} aria-label="Find a connector" placeholder="Find a connector" value={filter} data-testid="workbot-source-other-filter"
              onChange={(event) => setFilter(event.target.value)} />
          </div>
        ) : null}
        {everything.length === 0 ? <p className="px-6 py-3 text-[13px] text-gray-500" data-testid="workbot-source-other-empty">No connectors</p> : null}
        {everything.length > 0 && all.length === 0 ? <p className="px-6 py-3 text-[13px] text-gray-500" data-testid="workbot-source-other-none-added">No connectors added</p> : null}
        {all.length > 0 && every.length === 0 ? <p className="px-6 py-3 text-[13px] text-gray-500" data-testid="workbot-source-other-no-match">No connectors match</p> : null}
        {every.map((option) => {
          const policy = otherPolicy(view, option);
          return (
            <div key={option.id} data-testid={`workbot-source-other-${option.id}`} data-policy={policy}>
              <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-3 px-6 py-2">
                <span className="flex min-w-0 items-center gap-3">
                  <ConnectorLogo name={option.name} url={option.url} size="xs" />
                  <span className={`truncate text-[13px] ${policy === "off" ? "text-gray-500" : "text-gray-900"}`}>{option.name}</span>
                  {policy !== "off" ? toolsButtonOf(option) : null}
                </span>
                <span className="flex min-w-0 flex-wrap items-center justify-end gap-3">
                  <PolicySelect label={option.name} value={policy} disabled={locked} onChange={(next) => save({ connections: { [option.id]: next } })} />
                  {view.settings.sources.connections[option.id] !== undefined ? (
                    <DenButton variant="ghost" size="xs" disabled={locked} aria-label={`Remove ${option.name} from Connectors`}
                      onClick={() => save({ connections: { [option.id]: null } })}>
                      Remove
                    </DenButton>
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}
        {rest.length > 0 ? (
          <>
            <AddConnector options={rest} disabled={locked} onPick={(option) => save({ connections: { [option.id]: "members" } })} />
            <p className="px-6 pb-2 text-[12px] text-gray-500" data-testid="workbot-source-other-rest">{otherConnectionsRestLine(rest.length)}</p>
          </>
        ) : null}
      </>
    );
  };

  // Before the brief: each connection added here, with its own policy.
  const listedRows = () => {
    const members = listedConnections(view);
    return (
      <>
        {members.length === 0 ? <p className="px-6 py-3 text-[13px] text-gray-500" data-testid="workbot-source-other-empty">No connectors</p> : null}
        {members.map((option) => (
          <div key={option.id} className="flex min-h-[44px] flex-wrap items-center justify-between gap-3 px-6 py-2" data-testid={`workbot-source-other-${option.id}`}>
            <span className="flex min-w-0 items-center gap-3">
              <ConnectorLogo name={option.name} url={option.url} size="xs" />
              <span className="truncate text-[13px] text-gray-900">{option.name}</span>
            </span>
            <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <PolicySelect label={option.name} value={agentSourcePolicy(sources, option.id)} disabled={locked}
                onChange={(policy) => save({ connections: { [option.id]: policy } })} />
              <DenButton variant="ghost" size="xs" disabled={locked} aria-label={`Remove ${option.name} from Connectors`}
                onClick={() => save(removeConnectionChange(view, option.id))}>
                Remove
              </DenButton>
            </span>
          </div>
        ))}
        <AddConnector options={addableConnections(view)} disabled={locked} onPick={(option) => save(addConnectionChange(view, option.id))} />
      </>
    );
  };

  return (
    <section aria-labelledby={heading ? headingId : undefined} aria-label={heading ? undefined : "Connectors"} className="grid gap-2" data-section="workbot-proactive-sources">
      {heading ? (
        <div className="flex items-center justify-between gap-3 px-1">
          <h2 id={headingId} className="text-[13px] font-medium text-gray-500">Connectors</h2>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-sources">
        {connections ? (
          <div className="divide-y divide-gray-100" data-testid="workbot-source-others">
            {anyConnector ? everyConnectionRows() : listedRows()}
          </div>
        ) : (
          <p className="flex items-center gap-2 px-6 py-3 text-[12px] text-gray-500" data-testid="workbot-source-others-locked">
            <Lock size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
            {`Connectors: ${permissionLockReason("connections.view")}`}
          </p>
        )}
        <p className="border-t border-gray-100 px-6 py-3 text-[12px] text-gray-500" data-testid="workbot-source-footer">
          {anyConnector && connections ? `${connectionCount(connections.other.length)}. ` : ""}Read only. Agents never send, edit or delete through these.
        </p>
      </div>
    </section>
  );
}
