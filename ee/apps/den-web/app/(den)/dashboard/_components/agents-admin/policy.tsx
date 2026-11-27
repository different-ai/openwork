import { PERSONAL_AGENT_ORG_RULES_MAX_LENGTH, personalAgentShareModeSchema, type PersonalAgentAccess, type PersonalAgentOrgPolicy } from "@openwork/types/den/personal-agents";
import { useRef, useState, type ReactNode } from "react";
import { DenButton, buttonVariants } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSelect } from "../../../_components/ui/select";
import { DenSwitch } from "../../../_components/ui/switch";
import { DenTextarea } from "../../../_components/ui/textarea";
import { toolTitle } from "../connector-setup";
import { isNativeProviderConnectionId, useMcpConnections, useMcpConnectionTools } from "../mcp-connections-data";
import { useEditAgentPolicy, type PolicyEdit } from "./data";
import { ActionDialog, AddToolRuleDialog, BudgetSelect, orgBudgets, ToolRuleSelect, type DialogProps } from "./dialogs";

const muted = "text-[13px] text-[var(--dls-text-secondary)]";
const divided = "divide-y divide-[var(--dls-border)] border-y border-[var(--dls-border)]";
const saveError = "Could not save this change. Try again.";
const rulesLabel = "Rules every agent follows";

function Setting({ label, labelId, hint, truncate, children }: { label: string; labelId?: string; hint?: string; truncate?: boolean; children: ReactNode }) {
  return <div className="flex min-h-10 items-center justify-between gap-4 py-2">
    <div className="min-w-0">
      <h3 id={labelId} className="text-[13px] font-medium">{label}</h3>
      {hint ? <p className={`${muted} ${truncate ? "truncate" : "break-words"}`}>{hint}</p> : null}
    </div>
    <div className="shrink-0">{children}</div>
  </div>;
}

function RulesDialog({ rules, onSave, ...dialog }: DialogProps & { rules: string; onSave: (rules: string) => void }) {
  const [draft, setDraft] = useState(rules);
  return <ActionDialog {...dialog} title={rulesLabel} action="Save" disabled={draft === rules} onSave={() => onSave(draft)}>
    <p id="agents-rules-help" className={muted}>Short, plain rules. Every run of every agent is told to follow them first.</p>
    <DenTextarea aria-label={rulesLabel} aria-describedby="agents-rules-help agents-rules-count" value={draft} rows={6}
      maxLength={PERSONAL_AGENT_ORG_RULES_MAX_LENGTH} disabled={dialog.busy} onChange={(event) => setDraft(event.target.value)} />
    <p id="agents-rules-count" className={`text-right tabular-nums ${muted}`}>{draft.length} / {PERSONAL_AGENT_ORG_RULES_MAX_LENGTH}</p>
  </ActionDialog>;
}

function ToolRuleRows({ connectionId, connectionName, tools, busy, onChange }: {
  connectionId: string;
  connectionName?: string;
  tools: Record<string, PersonalAgentAccess>;
  busy: boolean;
  onChange: (name: string, rule: PersonalAgentAccess | null) => void;
}) {
  const { data } = useMcpConnectionTools(connectionId, Boolean(connectionName));
  return Object.entries(tools).map(([name, rule]) => {
    const tool = data?.tools.find((entry) => entry.name === name);
    const label = `${connectionName ?? "Unavailable connection"} · ${toolTitle(tool ?? { name })}`;
    return <li key={name} className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1 text-[13px]">
      <span className="min-w-0 break-words">{label}</span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ToolRuleSelect label={`Rule for ${label}`} value={rule} disabled={busy} onChange={(value) => onChange(name, value)} />
        <DenButton variant="ghost" size="sm" disabled={busy} aria-label={`Remove rule for ${label}`} onClick={() => onChange(name, null)}>Remove</DenButton>
      </div>
    </li>;
  });
}

export function OrgAgentPolicy({ orgId, policy, connectorsHref }: { orgId: string; policy: PersonalAgentOrgPolicy; connectorsHref?: string }) {
  const [dialog, setDialog] = useState<"rules" | "tools" | null>(null);
  const toolTrigger = useRef<HTMLButtonElement>(null);
  const rulesTrigger = useRef<HTMLButtonElement>(null);
  const connections = useMcpConnections("manageable", { enabled: !connectorsHref });
  const edit = useEditAgentPolicy(orgId);
  const toolRules = Object.entries(policy.toolPolicy.tools).filter(([, tools]) => Object.keys(tools).length > 0);
  const builtIn = useMcpConnections("manageable");
  const candidates = connections.data?.filter(({ id, nativeProviderKey }) => !isNativeProviderConnectionId(id, nativeProviderKey)) ?? [];
  const builtInConnections = [
    { id: "openwork", name: "OpenWork", hint: "Agents, routines, Automations and the rest of your organization's OpenWork data." },
    ...(builtIn.data?.filter(({ id, nativeProviderKey }) => isNativeProviderConnectionId(id, nativeProviderKey)).map(({ id, name }) => ({ id, name, hint: "" })) ?? []),
  ];
  const saveSettings = (settings: Extract<PolicyEdit, { action: "settings" }>["settings"]) => edit.mutate({ action: "settings", settings });
  const saveDialog = (change: PolicyEdit) => edit.mutate(change, { onSuccess: () => setDialog(null) });
  const open = (kind: "rules" | "tools") => { edit.reset(); setDialog(kind); };
  const dialogProps = {
    busy: edit.isPending,
    error: edit.isError ? saveError : null,
    onClose: () => { edit.reset(); setDialog(null); },
  };

  return <>
    <section aria-labelledby="agents-policy-title" className="space-y-3">
      <h2 id="agents-policy-title" className="text-base font-semibold">For every agent</h2>
      <div className={divided}>
        <Setting label="Who can share agents" hint="Agents already shared stay shared.">
          <div data-agents-share-mode="">
            <DenSelect size="sm" aria-label="Who can share agents" value={policy.shareMode} disabled={edit.isPending} onChange={(event) => {
              const mode = personalAgentShareModeSchema.safeParse(event.target.value);
              if (mode.success) saveSettings({ shareMode: mode.data });
            }}>
              <option value="everyone">Everyone</option>
              <option value="admins">Admins only</option>
            </DenSelect>
          </div>
        </Setting>
        <Setting label="Shared logins" hint={policy.sharedLogins
          ? "An owner or manager can let teammates act through their own account on a connection. Teammates see whose account it is."
          : "Everyone who uses a shared agent acts with their own accounts."}>
          <div data-agents-shared-logins="">
            <DenSwitch aria-label="Shared logins" checked={policy.sharedLogins} disabled={edit.isPending} onChange={(sharedLogins) => saveSettings({ sharedLogins })} />
          </div>
        </Setting>
        {connectorsHref ? null : <Setting label={rulesLabel} hint={policy.rules.split(/\r?\n/, 1)[0]?.trim() || "No rules yet."} truncate>
          <button type="button" ref={rulesTrigger} data-agents-rules="" aria-label="Edit rules every agent follows"
            className={buttonVariants({ variant: "secondary", size: "sm", className: "disabled:opacity-60" })}
            disabled={edit.isPending} onClick={() => open("rules")}>Edit…</button>
        </Setting>}
        <Setting label="Most an agent may spend in a month" labelId="agents-org-budget">
          <BudgetSelect label="Most an agent may spend in a month" value={policy.monthlyBudgetMicros} limits={orgBudgets}
            disabled={edit.isPending} onChange={(monthlyBudgetMicros) => saveSettings({ monthlyBudgetMicros })} />
        </Setting>
      </div>
    </section>
    <section aria-labelledby="agents-built-in-title" className="space-y-3">
      <div>
        <h2 id="agents-built-in-title" className="text-base font-semibold">Built-in tools agents may use</h2>
        <p className={muted}>Each starts off for a new agent until its owner turns it on. Turn one off here and no agent can use it or ask for it.</p>
      </div>
      <div className={divided}>
        {builtInConnections.map(({ id, name, hint }) => <Setting key={id} label={name} hint={hint || undefined}>
          <div data-agents-built-in={id}>
            <DenSwitch aria-label={`Agents may use ${name}`} checked={policy.toolPolicy.connections[id] !== "block"} disabled={edit.isPending}
              onChange={(allowed) => edit.mutate({ action: "connection", connectionId: id, blocked: !allowed })} />
          </div>
        </Setting>)}
      </div>
    </section>
    {connectorsHref ? <p className={muted}>Tool rules and written rules now apply to everything, not only agents. Set them under <a className="underline underline-offset-2" href={connectorsHref}>Connectors</a>.</p> : <section aria-labelledby="agents-tool-rules-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="agents-tool-rules-title" className="text-base font-semibold">Tool rules for every agent</h2>
          <p className={muted}>Ask first wins over what an agent&apos;s owner chose. Blocked wins over everything.</p>
        </div>
        <button type="button" ref={toolTrigger} data-agents-block-tool="" data-agents-add-rule=""
          className={buttonVariants({ variant: "secondary", size: "sm", className: "disabled:opacity-60" })}
          disabled={edit.isPending || !connections.data} onClick={() => open("tools")}>Add a tool rule…</button>
      </div>
      {connections.isError ? <div className="space-y-2">
        <DenNotice tone="error" message="Could not load connections." />
        <DenButton variant="secondary" size="sm" onClick={() => void connections.refetch()}>Try again</DenButton>
      </div> : null}
      {toolRules.length ? <ul className={divided}>
        {toolRules.map(([connectionId, tools]) => <ToolRuleRows key={connectionId} connectionId={connectionId} tools={tools}
          connectionName={connections.data?.find(({ id }) => id === connectionId)?.name} busy={edit.isPending}
          onChange={(name, rule) => edit.mutate({ action: "tools", connectionId, toolNames: [name], rule })} />)}
      </ul> : <p className={muted}>No tool rules yet.</p>}
    </section>}
    {(connectorsHref || !dialog) && edit.isError ? <DenNotice tone="error" message={saveError} /> : null}
    {!connectorsHref && dialog === "tools" ? <AddToolRuleDialog {...dialogProps} connections={candidates} finalFocus={toolTrigger} onSave={saveDialog} /> : null}
    {!connectorsHref && dialog === "rules" ? <RulesDialog {...dialogProps} rules={policy.rules} finalFocus={rulesTrigger}
      onSave={(rules) => saveDialog({ action: "settings", settings: { rules } })} /> : null}
  </>;
}
