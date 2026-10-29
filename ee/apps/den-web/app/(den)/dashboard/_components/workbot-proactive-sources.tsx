"use client";

import { Lock, Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
  AGENT_CORE_SOURCES,
  AGENT_CORE_SOURCE_COPY,
  AGENT_READ_TOOLS_MAX,
  AGENT_SOURCE_POLICIES,
  AGENT_SOURCE_POLICY_COPY,
  AGENT_SOURCE_SLOTS,
  agentApprovedTools,
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
import { DenSelectableRow } from "../../_components/ui/selectable-row";
import { ConnectorLogo } from "./item-logo";
import { SourceIcon } from "./source-icon";
import { useWorkbotSourceTools, type WorkbotSourceTool } from "./workbot-proactive-data";

/**
 * Manage › Workbot › What agents read: calendar, email, team chat and Other context, each with the connections it reads
 * through. Admins add any of the organization's connections to any of them (an MCP without reviewed reads only with
 * the tools they approve) and remove them again. The server enforces it for members' agents.
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

/** Whether a connection needs tools approved before agents can read it. */
export function needsApproval(view: SourcesView, option: AgentSourceOption): boolean {
  return !option.reviewed && agentApprovedTools(view.settings.sources, option.id).length === 0;
}

function withSlot(slot: AgentSourceSlot, ids: string[]): AgentSourcesPolicyInput {
  if (slot === "other") return { otherConnections: ids };
  const coreConnections: NonNullable<AgentSourcesPolicyInput["coreConnections"]> = {};
  coreConnections[slot] = ids;
  return { coreConnections };
}

/** The tools approved for a connection, with each one's version as the admin saw it, so the server approves only that. */
export type ToolApproval = { tools: string[]; versions: Record<string, string> };

export function approveToolsChange(connectionId: string, approval: ToolApproval): AgentSourcesPolicyInput {
  return { readTools: { [connectionId]: approval.tools }, readToolVersions: { [connectionId]: approval.versions } };
}

/** Adds a connection to one source, with the tools approved for it when it needs them. */
export function addSourceChange(view: SourcesView, slot: AgentSourceSlot, connectionId: string, approval?: ToolApproval): AgentSourcesPolicyInput {
  return { ...withSlot(slot, [...slotIds(view, slot), connectionId]), ...(approval?.tools.length ? approveToolsChange(connectionId, approval) : {}) };
}

/** Takes a connection out of one source only; its approved tools go once it is in none. */
export function removeSourceChange(view: SourcesView, slot: AgentSourceSlot, connectionId: string): AgentSourcesPolicyInput {
  const change = withSlot(slot, slotIds(view, slot).filter((id) => id !== connectionId));
  const elsewhere = AGENT_SOURCE_SLOTS.some((other) => other !== slot && slotIds(view, other).includes(connectionId));
  return {
    ...change,
    ...(slot === "other" ? { connections: { [connectionId]: null } } : {}),
    ...(!elsewhere && agentApprovedTools(view.settings.sources, connectionId).length ? { readTools: { [connectionId]: null } } : {}),
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

function toolCount(count: number) {
  return `Approved by your admin: ${count} ${count === 1 ? "tool" : "tools"}`;
}

/**
 * Why a tool can or can't be approved, or that an approval needs renewing: only tools the provider marks read-only can
 * be, and an approval stops working when the provider changes the tool, until it is approved again.
 */
export function toolState(tool: WorkbotSourceTool): string {
  if (tool.blocked) return tool.readOnlyHint === undefined ? "Not marked read-only by the provider" : "Can change things";
  if (tool.changed) return "Changed by the provider. Approve again";
  return "Marked read-only by the provider";
}

/**
 * Which of an MCP connection's tools agents may call. Nothing starts ticked; tools that change things, or that the
 * provider doesn't mark read-only, can't be. Saving approves the ticked tools as they are listed now.
 */
export function SourceToolPicker({ name, tools, error, initial, saving, onSave, onCancel }: {
  name: string;
  /** Null while loading. */
  tools: readonly WorkbotSourceTool[] | null;
  error: string | null;
  initial: readonly string[];
  saving: boolean;
  onSave: (approval: ToolApproval) => void;
  onCancel: () => void;
}) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(initial));
  const labelId = useId();
  const chosen = (tools ?? []).filter((tool) => !tool.blocked && ticked.has(tool.name)).map((tool) => tool.name);
  return (
    <div className="grid gap-2 py-2 pl-14 pr-6" role="group" aria-labelledby={labelId} data-testid="workbot-source-tool-picker">
      <p id={labelId} className="text-[12px] font-medium text-gray-700">{`Tools agents may use in ${name}`}</p>
      {error ? <p role="alert" className="text-[12px] text-red-700">{error}</p> : null}
      {tools === null && !error ? (
        <div className="grid gap-1" aria-busy="true">
          {[0, 1, 2].map((key) => <div key={key} className="h-10 animate-pulse rounded-lg bg-gray-50 motion-reduce:animate-none" />)}
        </div>
      ) : null}
      {tools && tools.length === 0 ? <p className="text-[12px] text-gray-500">{`${name} offers no tools.`}</p> : null}
      {tools && tools.length ? (
        <div className="max-h-80 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-100">
          {tools.map((tool) => (
            <DenSelectableRow key={tool.name} data-testid={`workbot-source-tool-${tool.name}`} className="py-2"
              title={tool.name}
              description={toolState(tool)}
              selected={!tool.blocked && ticked.has(tool.name)}
              disabled={tool.blocked || saving || (!ticked.has(tool.name) && chosen.length >= AGENT_READ_TOOLS_MAX)}
              onClick={() => setTicked((current) => {
                const next = new Set(current);
                if (next.has(tool.name)) next.delete(tool.name);
                else next.add(tool.name);
                return next;
              })} />
          ))}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <DenButton variant="ghost" size="sm" onClick={onCancel}>Cancel</DenButton>
        <DenButton variant="primary" size="sm" disabled={chosen.length === 0} loading={saving} onClick={() => onSave({ tools: chosen, versions: Object.fromEntries((tools ?? []).filter((tool) => chosen.includes(tool.name)).map((tool) => [tool.name, tool.version])) })}>
          {chosen.length ? `Approve ${chosen.length} ${chosen.length === 1 ? "tool" : "tools"}` : "Approve tools"}
        </DenButton>
      </div>
    </div>
  );
}

function ToolPickerLoader({ orgId, option, initial, saving, onSave, onCancel }: {
  orgId: string;
  option: AgentSourceOption;
  initial: readonly string[];
  saving: boolean;
  onSave: (approval: ToolApproval) => void;
  onCancel: () => void;
}) {
  const query = useWorkbotSourceTools(orgId, option.id);
  return (
    <SourceToolPicker name={option.name} tools={query.data ?? null} error={query.isError ? query.error.message : null}
      initial={initial} saving={saving} onSave={onSave} onCancel={onCancel} />
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

/** The tool picker open for one connection: to add it to a source, or to change its approved tools. */
type Picking = { slot: AgentSourceSlot; option: AgentSourceOption; adding: boolean };

export function WorkbotProactiveSources({ orgId = "", view, canManage, saving, onChange, initialPicking = null }: {
  orgId?: string;
  view: WorkbotProactiveView;
  canManage: boolean;
  saving: boolean;
  onChange: (change: WorkbotProactiveSettingsInput) => void;
  initialPicking?: Picking | null;
}) {
  const headingId = useId();
  const [picking, setPicking] = useState<Picking | null>(initialPicking);
  const locked = !canManage || saving;
  const { sources } = view.settings;
  const connections = view.sourceConnections;

  const save = (change: AgentSourcesPolicyInput) => onChange({ sources: change });
  const picker = (slot: AgentSourceSlot, option: AgentSourceOption) => picking && picking.slot === slot && picking.option.id === option.id ? (
    orgId ? (
      <ToolPickerLoader orgId={orgId} option={option} initial={agentApprovedTools(sources, option.id)} saving={saving}
        onCancel={() => setPicking(null)}
        onSave={(approval) => {
          save(picking.adding ? addSourceChange(view, slot, option.id, approval) : approveToolsChange(option.id, approval));
          setPicking(null);
        }} />
    ) : <SourceToolPicker name={option.name} tools={null} error={null} initial={[]} saving={saving} onSave={() => undefined} onCancel={() => setPicking(null)} />
  ) : null;

  const sourceRows = (slot: AgentSourceSlot) => {
    const members = slotMembers(view, slot);
    const pendingAdd = picking?.adding && picking.slot === slot ? picking.option : null;
    return (
      <>
        {members.length === 0 && !pendingAdd ? <p className="py-2 pl-14 pr-6 text-[13px] text-gray-500" data-testid={`workbot-source-${slot}-empty`}>No sources</p> : null}
        {members.map((option) => {
          const approved = agentApprovedTools(sources, option.id);
          const state = slot === "calendar" && option.native === false ? "Read on checks; no early meeting alerts" : null;
          return (
            <div key={option.id} className="divide-y divide-gray-100">
              <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-3 py-2 pl-14 pr-6" data-testid={`workbot-source-${slot}-${option.id}`}>
                <span className="flex min-w-0 items-center gap-3">
                  <ConnectorLogo name={option.name} url={option.url} size="xs" />
                  <span className="truncate text-[13px] text-gray-900">{option.name}</span>
                  {state ? <span className="text-[12px] text-gray-500">{state}</span> : null}
                </span>
                <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  {!option.reviewed ? (
                    <button type="button" disabled={locked} onClick={() => setPicking({ slot, option, adding: false })}
                      className="rounded-md px-1 text-[12px] text-gray-500 underline-offset-2 outline-hidden hover:text-gray-900 hover:underline focus-visible:ring-2 focus-visible:ring-gray-900/5 disabled:cursor-not-allowed disabled:no-underline">
                      {approved.length ? toolCount(approved.length) : "No tools approved"}
                    </button>
                  ) : null}
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
              {picker(slot, option)}
            </div>
          );
        })}
        {pendingAdd ? (
          <div className="divide-y divide-gray-100" data-testid={`workbot-source-${slot}-adding`}>
            <div className="flex min-h-[44px] items-center gap-3 py-2 pl-14 pr-6">
              <ConnectorLogo name={pendingAdd.name} url={pendingAdd.url} size="xs" />
              <span className="truncate text-[13px] text-gray-900">{pendingAdd.name}</span>
              <span className="text-[12px] text-gray-500">Not added yet</span>
            </div>
            {picker(slot, pendingAdd)}
          </div>
        ) : null}
        <AddSource slot={slot} options={addableTo(view, slot)} disabled={locked}
          onPick={(option) => {
            if (needsApproval(view, option)) setPicking({ slot, option, adding: true });
            else save(addSourceChange(view, slot, option.id));
          }} />
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
