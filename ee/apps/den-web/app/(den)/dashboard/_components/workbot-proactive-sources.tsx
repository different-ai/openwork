"use client";

import { Lock, Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
  AGENT_CORE_SOURCES,
  AGENT_CORE_SOURCE_COPY,
  AGENT_SOURCE_POLICIES,
  AGENT_SOURCE_POLICY_COPY,
  agentCoreConnections,
  agentOtherConnections,
  agentSourcePolicy,
  type AgentSourceOption,
  type AgentSourcePolicy,
  type AgentSourceSlot,
  type AgentSourcesPolicyInput,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { permissionLockReason } from "../../_lib/den-org";
import { DenButton } from "../../_components/ui/button";
import { DenDropdownPopup, DenDropdownRoot, DenDropdownTrigger } from "../../_components/ui/dropdown-popup";
import { denDropdownListClass, denDropdownRowBaseClass, denDropdownRowIdleClass } from "../../_components/ui/dropdown-styles";
import { DenSelect } from "../../_components/ui/select";
import { ConnectorLogo } from "./item-logo";
import { SourceIcon } from "./source-icon";

/**
 * Manage › Workbot › What agents read: calendar, email, team chat and Other context, each with the connections it reads
 * through. Admins add the organization's connections to them (Den's own providers for what they serve, an MCP whose
 * read tools are reviewed anywhere) and remove them again. The server enforces it for members' agents.
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

/** Connections that can still be added to a source. */
export function addableTo(view: SourcesView, slot: AgentSourceSlot): AgentSourceOption[] {
  const here = new Set(slotIds(view, slot));
  return (view.sourceConnections?.all ?? []).filter((option) => option.slots.includes(slot) && !here.has(option.id));
}

function withSlot(slot: AgentSourceSlot, ids: string[]): AgentSourcesPolicyInput {
  if (slot === "other") return { otherConnections: ids };
  const coreConnections: NonNullable<AgentSourcesPolicyInput["coreConnections"]> = {};
  coreConnections[slot] = ids;
  return { coreConnections };
}

/** Adds a connection to one source. */
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
              <button key={option.id} type="button" role="menuitem" className={`${denDropdownRowBaseClass} ${denDropdownRowIdleClass} items-center justify-start`}
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

  const sourceRows = (slot: AgentSourceSlot) => {
    const members = slotMembers(view, slot);
    return (
      <>
        {members.length === 0 ? <p className="py-2 pl-14 pr-6 text-[13px] text-gray-500" data-testid={`workbot-source-${slot}-empty`}>No sources</p> : null}
        {members.map((option) => {
          const state = slot === "calendar" && option.native === false ? "Read on checks; no early meeting alerts" : null;
          return (
            <div key={option.id} className="flex min-h-[44px] flex-wrap items-center justify-between gap-3 py-2 pl-14 pr-6" data-testid={`workbot-source-${slot}-${option.id}`}>
                <span className="flex min-w-0 items-center gap-3">
                  <ConnectorLogo name={option.name} url={option.url} size="xs" />
                  <span className="truncate text-[13px] text-gray-900">{option.name}</span>
                  {state ? <span className="text-[12px] text-gray-500">{state}</span> : null}
                </span>
                <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  {slot === "other" ? (
                    <PolicySelect label={option.name} value={agentSourcePolicy(sources, option.id)} disabled={locked}
                      onChange={(policy) => save({ connections: { [option.id]: policy } })} />
                  ) : null}
                  <DenButton variant="ghost" size="xs" disabled={locked} aria-label={`Remove ${option.name} from ${SLOT_LABEL[slot]}`}
                    onClick={() => save(removeSourceChange(view, slot, option.id))}>
                    Remove
                  </DenButton>
                </span>
            </div>
          );
        })}
        <AddSource slot={slot} options={addableTo(view, slot)} disabled={locked} onPick={(option) => save(addSourceChange(view, slot, option.id))} />
      </>
    );
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-2" data-section="workbot-proactive-sources">
      <h2 id={headingId} className="px-1 text-[13px] font-medium text-gray-500">What agents read</h2>
      <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-sources">
        {AGENT_CORE_SOURCES.map((kind) => {
          const label = AGENT_CORE_SOURCE_COPY[kind].label;
          const first = slotMembers(view, kind)[0];
          return (
            <div key={kind} className="pb-1">
              <div className="flex min-h-[48px] flex-wrap items-center justify-between gap-3 px-6 py-2" data-testid={`workbot-source-${kind}`}>
                <span className="flex min-w-0 items-center gap-3">
                  {first ? <ConnectorLogo name={first.name} url={first.url} size="xs" /> : <SourceIcon kind={kind} />}
                  <span className="text-[13px] font-medium text-gray-900">{label}</span>
                  {connections ? null : <span className="text-[12px] text-gray-500">{AGENT_CORE_SOURCE_COPY[kind].via}</span>}
                </span>
                <PolicySelect label={label} value={sources[kind]} disabled={locked} onChange={(policy) => save(corePolicy(kind, policy))} />
              </div>
              {connections && sources[kind] !== "off" ? sourceRows(kind) : null}
            </div>
          );
        })}
        {connections ? (
          <div className="pb-1" data-testid="workbot-source-others">
            <div className="flex min-h-[48px] items-center px-6 py-2">
              <span className="text-[13px] font-medium text-gray-900">Other context</span>
            </div>
            {sourceRows("other")}
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
