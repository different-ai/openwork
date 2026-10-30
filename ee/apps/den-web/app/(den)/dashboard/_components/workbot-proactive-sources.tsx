"use client";

import { Lock, Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
  AGENT_CORE_SOURCES,
  AGENT_CORE_SOURCE_COPY,
  AGENT_SOURCE_POLICIES,
  AGENT_SOURCE_POLICY_COPY,
  agentCoreConnections,
  agentCoreDefault,
  agentOtherConnections,
  agentSourcePolicy,
  type AgentCoreSource,
  type AgentSourceOption,
  type AgentSourcePolicy,
  type AgentSourceSlot,
  type AgentSourcesPolicyInput,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { permissionLockReason } from "../../_lib/den-org";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenDropdownPopup, DenDropdownRoot, DenDropdownTrigger } from "../../_components/ui/dropdown-popup";
import { denDropdownListClass, denDropdownRowBaseClass, denDropdownRowIdleClass } from "../../_components/ui/dropdown-styles";
import { DenSelect } from "../../_components/ui/select";
import { DenSwitch } from "../../_components/ui/switch";
import { ConnectorLogo } from "./item-logo";
import { SourceIcon } from "./source-icon";

/**
 * Manage › Workbot › What agents read. The admin sets guardrails and each member picks within them: for calendar,
 * email and team chat, which apps are allowed (Den's own providers for what they serve, an MCP whose read tools are
 * reviewed once added) and which one is the default; each member's agent then reads one allowed app per category.
 * Other context is the connections added there, each with its own policy. The server enforces it for members' agents.
 */

type SourcesView = Pick<WorkbotProactiveView, "settings" | "sourceConnections">;

const SLOT_LABEL: Record<AgentSourceSlot, string> = {
  calendar: AGENT_CORE_SOURCE_COPY.calendar.label,
  email: AGENT_CORE_SOURCE_COPY.email.label,
  chat: AGENT_CORE_SOURCE_COPY.chat.label,
  other: "Other context",
};

/** The ids a source reads through now: the admin's list, or what serves it before they pick. */
function slotIds(view: SourcesView, slot: AgentSourceSlot): string[] {
  const { sources } = view.settings;
  const picked = slot === "other" ? agentOtherConnections(sources) : agentCoreConnections(sources, slot);
  return [...(picked ?? view.sourceConnections?.[slot].map((connection) => connection.id) ?? [])];
}

/** The connections a source reads through, as the admin added them. */
export function slotMembers(view: SourcesView, slot: AgentSourceSlot): AgentSourceOption[] {
  const all = view.sourceConnections?.all ?? [];
  return slotIds(view, slot).flatMap((id) => all.filter((option) => option.id === id));
}

/** One app behind calendar, email or team chat, as the admin sees it. */
export type CoreAppRow = { option: AgentSourceOption; allowed: boolean; isDefault: boolean };

/** What serves a core source before the admin picks: Google Workspace, Microsoft 365, Slack. */
function servingIds(view: SourcesView, kind: AgentCoreSource): string[] {
  return view.sourceConnections?.[kind].map((connection) => connection.id) ?? [];
}

/** The apps allowed for a core source that the organization still has. */
function allowedIds(view: SourcesView, kind: AgentCoreSource): string[] {
  const all = view.sourceConnections?.all ?? [];
  return slotIds(view, kind).filter((id) => all.some((option) => option.id === id));
}

/**
 * The default a core source uses now: the admin's while it is allowed, else the server's automatic one, else the
 * allowed app most members connected (while a change is still saving).
 */
export function coreDefault(view: SourcesView, kind: AgentCoreSource): string | null {
  const allowed = allowedIds(view, kind);
  const admin = agentCoreDefault(view.settings.sources, kind);
  if (admin && allowed.includes(admin)) return admin;
  const server = view.sourceConnections?.defaults[kind] ?? null;
  if (server && allowed.includes(server)) return server;
  const all = view.sourceConnections?.all ?? [];
  const count = (id: string) => all.find((option) => option.id === id)?.connectedMembers ?? 0;
  return allowed.reduce<string | null>((best, id) => (best === null || count(id) > count(best) ? id : best), null);
}

/** Every app that serves a core source, then any other the admin allowed for it, with whether it is allowed and the default. */
export function coreAppRows(view: SourcesView, kind: AgentCoreSource): CoreAppRow[] {
  const all = view.sourceConnections?.all ?? [];
  const allowed = new Set(allowedIds(view, kind));
  const fallback = coreDefault(view, kind);
  return [...new Set([...servingIds(view, kind), ...allowed])].flatMap((id) => {
    const option = all.find((entry) => entry.id === id);
    return option ? [{ option, allowed: allowed.has(id), isDefault: allowed.has(id) && id === fallback }] : [];
  });
}

/** "Members use Google Workspace or Microsoft 365", "Everyone uses Google Workspace", "No apps allowed". */
export function coreStateLine(view: SourcesView, kind: AgentCoreSource): string {
  if (view.settings.sources[kind] === "off") return "Agents don't read it";
  const names = coreAppRows(view, kind).filter((row) => row.allowed).map((row) => row.option.name);
  if (names.length === 0) return "No apps allowed";
  if (names.length === 1) return `Everyone uses ${names[0]}`;
  return `Members use ${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** Allows or stops allowing one app for a core source; the full serving set goes back to null (every one that serves it). */
export function allowAppChange(view: SourcesView, kind: AgentCoreSource, connectionId: string, allow: boolean): AgentSourcesPolicyInput {
  const order = coreAppRows(view, kind).map((row) => row.option.id);
  const current = allowedIds(view, kind);
  const next = order.filter((id) => (id === connectionId ? allow : current.includes(id)));
  const serving = servingIds(view, kind);
  const everyServing = next.length === serving.length && serving.every((id) => next.includes(id));
  const coreConnections: NonNullable<AgentSourcesPolicyInput["coreConnections"]> = {};
  coreConnections[kind] = everyServing ? null : next;
  return { coreConnections };
}

/** Makes one allowed app the default for a core source. */
export function makeDefaultChange(kind: AgentCoreSource, connectionId: string): AgentSourcesPolicyInput {
  const coreDefaults: NonNullable<AgentSourcesPolicyInput["coreDefaults"]> = {};
  coreDefaults[kind] = connectionId;
  return { coreDefaults };
}

/** Connections that can still be added to a source: for calendar, email and team chat, those without a row there yet. */
export function addableTo(view: SourcesView, slot: AgentSourceSlot): AgentSourceOption[] {
  const here = new Set(slot === "other" ? slotIds(view, slot) : coreAppRows(view, slot).map((row) => row.option.id));
  return (view.sourceConnections?.all ?? []).filter((option) => option.slots.includes(slot) && !here.has(option.id));
}

function withSlot(slot: AgentSourceSlot, ids: string[]): AgentSourcesPolicyInput {
  if (slot === "other") return { otherConnections: ids };
  const coreConnections: NonNullable<AgentSourcesPolicyInput["coreConnections"]> = {};
  coreConnections[slot] = ids;
  return { coreConnections };
}

/** Adds a connection to one source (for calendar, email or team chat: allows it). */
export function addSourceChange(view: SourcesView, slot: AgentSourceSlot, connectionId: string): AgentSourcesPolicyInput {
  return withSlot(slot, [...slotIds(view, slot), connectionId]);
}

/** Takes a connection out of one source only. */
export function removeSourceChange(view: SourcesView, slot: AgentSourceSlot, connectionId: string): AgentSourcesPolicyInput {
  return {
    ...withSlot(slot, slotIds(view, slot).filter((id) => id !== connectionId)),
    ...(slot === "other" ? { connections: { [connectionId]: null } } : {}),
  };
}

function corePolicy(slot: Exclude<AgentSourceSlot, "other">, policy: AgentSourcePolicy): AgentSourcesPolicyInput {
  const change: AgentSourcesPolicyInput = {};
  change[slot] = policy;
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

function AddSource({ slot, options, disabled, onPick }: { slot: AgentSourceSlot; options: AgentSourceOption[]; disabled: boolean; onPick: (option: AgentSourceOption) => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <DenDropdownRoot open={open} onOpenChange={setOpen}>
      <DenDropdownTrigger ref={triggerRef} type="button" disabled={disabled} aria-label={`Add source to ${SLOT_LABEL[slot]}`}
        data-testid={`workbot-source-add-${slot}`}
        className="flex min-h-[40px] items-center gap-2 rounded-lg pl-14 pr-6 text-left text-[13px] font-medium text-gray-700 outline-hidden hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-900/5 disabled:cursor-not-allowed disabled:opacity-60">
        <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
        Add source
      </DenDropdownTrigger>
      {open ? (
        <DenDropdownPopup anchor={triggerRef} popupRef={popupRef}>
          <div className={denDropdownListClass} role="menu" aria-label={`Connections to add to ${SLOT_LABEL[slot]}`}>
            {options.length === 0 ? <p className="px-3 py-2.5 text-[13px] text-gray-500">Every connection is already here.</p> : null}
            {options.map((option) => (
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

export function WorkbotProactiveSources({ view, canManage, saving, onChange }: {
  view: WorkbotProactiveView;
  canManage: boolean;
  saving: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
}) {
  const headingId = useId();
  const locked = !canManage || saving;
  const { sources } = view.settings;
  const connections = view.sourceConnections;

  const save = (change: AgentSourcesPolicyInput) => onChange({ sources: change });

  const coreRows = (kind: AgentCoreSource) => (
    <>
      {coreAppRows(view, kind).map(({ option, allowed, isDefault }) => {
        const state = kind === "calendar" && allowed && option.native === false ? "Read on checks; no early meeting alerts" : null;
        return (
          <div key={option.id} className="flex min-h-[44px] flex-wrap items-center justify-between gap-3 py-2 pl-14 pr-6" data-testid={`workbot-source-${kind}-${option.id}`} data-allowed={allowed} data-default={isDefault}>
            <span className="flex min-w-0 items-center gap-3">
              <ConnectorLogo name={option.name} url={option.url} size="xs" />
              <span className={`truncate text-[13px] ${allowed ? "text-gray-900" : "text-gray-500"}`}>{option.name}</span>
              {isDefault ? <DenBadge size="sm">Default</DenBadge> : null}
              {option.connectedMembers !== null ? <span className="whitespace-nowrap text-[12px] text-gray-500">{`${option.connectedMembers} connected`}</span> : null}
              {state ? <span className="text-[12px] text-gray-500">{state}</span> : null}
            </span>
            <span className="flex min-w-0 items-center justify-end gap-3">
              {allowed && !isDefault ? (
                <DenButton variant="ghost" size="xs" disabled={locked} aria-label={`Make ${option.name} the default for ${SLOT_LABEL[kind]}`}
                  onClick={() => save(makeDefaultChange(kind, option.id))}>
                  Make default
                </DenButton>
              ) : null}
              <DenSwitch size="sm" aria-label={`Allow ${option.name}`} checked={allowed} disabled={locked || isDefault}
                onChange={(allow) => save(allowAppChange(view, kind, option.id, allow))} />
            </span>
          </div>
        );
      })}
      <AddSource slot={kind} options={addableTo(view, kind)} disabled={locked} onPick={(option) => save(addSourceChange(view, kind, option.id))} />
    </>
  );

  // Other context: each connection added there, with its own policy, kept as it was.
  const otherRows = () => {
    const members = slotMembers(view, "other");
    return (
      <>
        {members.length === 0 ? <p className="py-2 pl-14 pr-6 text-[13px] text-gray-500" data-testid="workbot-source-other-empty">No sources</p> : null}
        {members.map((option) => (
          <div key={option.id} className="flex min-h-[44px] flex-wrap items-center justify-between gap-3 py-2 pl-14 pr-6" data-testid={`workbot-source-other-${option.id}`}>
            <span className="flex min-w-0 items-center gap-3">
              <ConnectorLogo name={option.name} url={option.url} size="xs" />
              <span className="truncate text-[13px] text-gray-900">{option.name}</span>
            </span>
            <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <PolicySelect label={option.name} value={agentSourcePolicy(sources, option.id)} disabled={locked}
                onChange={(policy) => save({ connections: { [option.id]: policy } })} />
              <DenButton variant="ghost" size="xs" disabled={locked} aria-label={`Remove ${option.name} from ${SLOT_LABEL.other}`}
                onClick={() => save(removeSourceChange(view, "other", option.id))}>
                Remove
              </DenButton>
            </span>
          </div>
        ))}
        <AddSource slot="other" options={addableTo(view, "other")} disabled={locked} onPick={(option) => save(addSourceChange(view, "other", option.id))} />
      </>
    );
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-2" data-section="workbot-proactive-sources">
      <h2 id={headingId} className="px-1 text-[13px] font-medium text-gray-500">What agents read</h2>
      <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-sources">
        {AGENT_CORE_SOURCES.map((kind) => {
          const label = AGENT_CORE_SOURCE_COPY[kind].label;
          return (
            <div key={kind} className="pb-1">
              <div className="flex min-h-[48px] flex-wrap items-center justify-between gap-3 px-6 py-2" data-testid={`workbot-source-${kind}`}>
                <span className="flex min-w-0 items-center gap-3">
                  <SourceIcon kind={kind} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13px] font-medium text-gray-900">{label}</span>
                    <span className="truncate text-[12px] leading-4 text-gray-500" data-testid={`workbot-category-state-${kind}`}>
                      {connections ? coreStateLine(view, kind) : AGENT_CORE_SOURCE_COPY[kind].via}
                    </span>
                  </span>
                </span>
                <PolicySelect label={label} value={sources[kind]} disabled={locked} onChange={(policy) => save(corePolicy(kind, policy))} />
              </div>
              {connections && sources[kind] !== "off" ? coreRows(kind) : null}
            </div>
          );
        })}
        {connections ? (
          <div className="pb-1" data-testid="workbot-source-others">
            <div className="flex min-h-[48px] items-center px-6 py-2">
              <span className="text-[13px] font-medium text-gray-900">Other context</span>
            </div>
            {otherRows()}
          </div>
        ) : (
          <p className="flex items-center gap-2 px-6 py-3 text-[12px] text-gray-500" data-testid="workbot-source-others-locked">
            <Lock size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
            {`Sources: ${permissionLockReason("connections.view")}`}
          </p>
        )}
        <p className="px-6 py-3 text-[12px] text-gray-500" data-testid="workbot-source-footer">Read only. Agents never send, edit or delete through these.</p>
      </div>
    </section>
  );
}
