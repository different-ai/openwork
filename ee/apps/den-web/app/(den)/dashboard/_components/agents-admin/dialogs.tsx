import { Dialog } from "@base-ui/react/dialog";
import { personalAgentAccessSchema, type PersonalAgentAccess, type PersonalAgentAdminItem } from "@openwork/types/den/personal-agents";
import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenCheckbox } from "../../../_components/ui/checkbox";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSelect } from "../../../_components/ui/select";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import type { DenOrgMember } from "../../../_lib/den-org";
import { useMcpConnectionTools, type ExternalMcpConnection, type ExternalMcpTool } from "../mcp-connections-data";
import type { AgentEdit, PolicyEdit } from "./data";
import { formatAgentMoney } from "./words";

export type AgentDialogKind = "budget" | "transfer" | "archive";
const agentBudgets = [5, 10, 25, 50, 100];
export const orgBudgets = [10, 25, 50, 100, 250];
const descriptionClass = "text-[13px] leading-5 text-[var(--dls-text-secondary)]";

export type DialogProps = {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  finalFocus: RefObject<HTMLButtonElement | null>;
};

export function BudgetSelect({ label, value, limits, onChange, disabled }: {
  label: string;
  value: number | null;
  limits: readonly number[];
  onChange: (value: number | null) => void;
  disabled?: boolean;
}) {
  const amounts = limits.map((dollars) => dollars * 1_000_000);
  return <DenSelect aria-label={label} disabled={disabled} value={value === null ? "" : String(value)}
    onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}>
    <option value="">No limit</option>
    {amounts.map((amount) => <option key={amount} value={amount}>${amount / 1_000_000} a month</option>)}
    {value !== null && !amounts.includes(value) ? <option value={value}>{formatAgentMoney(value)} a month</option> : null}
  </DenSelect>;
}

export function ActionDialog({ title, action, busy, error, onClose, finalFocus, onSave, disabled, destructive, access, children }: DialogProps & {
  title: string;
  action: string;
  onSave: () => void;
  disabled?: boolean;
  destructive?: boolean;
  access?: boolean;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
        <Dialog.Popup initialFocus={destructive ? cancelRef : undefined} finalFocus={finalFocus} aria-busy={busy}
          data-agents-access-dialog={access ? "" : undefined}
          className="fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-surface)] p-5 outline-none">
          <Dialog.Title className="break-words text-base font-semibold">{title}</Dialog.Title>
          {children}
          {error ? <DenNotice tone="error" message={error} /> : null}
          <div className="flex justify-end gap-2">
            <Dialog.Close ref={cancelRef} disabled={busy} render={<DenButton variant="secondary" />}>Cancel</Dialog.Close>
            <DenButton variant={destructive ? "destructive" : "primary"} loading={busy} disabled={disabled} onClick={onSave}>{action}</DenButton>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AgentChangeDialog({ kind, item, members, onSave, ...dialog }: DialogProps & {
  kind: AgentDialogKind;
  item: PersonalAgentAdminItem;
  members: readonly DenOrgMember[];
  onSave: (edit: AgentEdit) => void;
}) {
  const [budget, setBudget] = useState(item.spend.adminBudgetMicros);
  const [memberId, setMemberId] = useState("");
  const name = item.agent.name;
  if (kind === "budget") return (
    <ActionDialog {...dialog} title={`Set budget for ${name}`} action="Save budget"
      disabled={budget === item.spend.adminBudgetMicros} onSave={() => onSave({ action: "budget", monthlyBudgetMicros: budget })}>
      <Dialog.Description className={descriptionClass}>The agent stops for the month when it reaches this.</Dialog.Description>
      <BudgetSelect label="Monthly budget" value={budget} limits={agentBudgets} onChange={setBudget} disabled={dialog.busy} />
    </ActionDialog>
  );
  if (kind === "archive") return (
    <ActionDialog {...dialog} title={`Archive ${name}?`} action="Archive agent" destructive onSave={() => onSave({ action: "archive" })}>
      <Dialog.Description className={descriptionClass}>{name} stops and its routines are archived. Run history is kept.</Dialog.Description>
    </ActionDialog>
  );
  const candidates = members.filter((member) => member.id !== item.owner.memberId && member.userId !== null)
    .map((member) => ({ id: member.id, name: member.user.name.trim() || "Unnamed member" }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const newOwner = candidates.find((member) => member.id === memberId);
  return (
    <ActionDialog {...dialog} title="Move to another owner" action="Move agent" disabled={!newOwner}
      onSave={() => { if (newOwner) onSave({ action: "transfer", memberId: newOwner.id }); }}>
      {candidates.length > 0 ? <DenSelect aria-label="New owner" value={memberId} disabled={dialog.busy}
        searchLabel="Find a member" onChange={(event) => setMemberId(event.target.value)}>
        <option value="" disabled>Choose a member</option>
        {candidates.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
      </DenSelect> : <Dialog.Description className={descriptionClass}>No other members can take ownership yet.</Dialog.Description>}
      {newOwner ? <Dialog.Description className={descriptionClass}>{name} and its routines will belong to {newOwner.name}. {item.owner.name || "The current owner"} loses access.</Dialog.Description> : null}
    </ActionDialog>
  );
}

export function agentToolTitle(tool: ExternalMcpTool) {
  return tool.title?.trim() || tool.annotations?.title?.trim() || tool.name;
}

function ToolCheckRow({ tool, disabled, checked, onChange }: {
  tool: ExternalMcpTool;
  disabled: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const reads = tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
  return <div className="flex min-h-10 items-center gap-3 py-2 text-[13px]">
    <DenCheckbox id={id} disabled={disabled} checked={checked} onCheckedChange={onChange} />
    <label htmlFor={id} className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
      <span className="break-all">{agentToolTitle(tool)}</span>
      <span className="shrink-0 text-[var(--dls-text-secondary)]">{reads ? "reads" : "changes things"}</span>
    </label>
  </div>;
}

export function ToolRuleSelect({ label, value, disabled, onChange }: {
  label: string;
  value: PersonalAgentAccess;
  disabled: boolean;
  onChange: (value: PersonalAgentAccess) => void;
}) {
  return <DenSelect aria-label={label} value={value} disabled={disabled} onChange={(event) => {
    const rule = personalAgentAccessSchema.safeParse(event.target.value);
    if (rule.success) onChange(rule.data);
  }}>
    <option value="ask">Ask first</option>
    <option value="allow">Allow automatically</option>
    <option value="block">Blocked</option>
  </DenSelect>;
}

export function AddToolRuleDialog({ connections, onSave, ...dialog }: DialogProps & {
  connections: readonly ExternalMcpConnection[];
  onSave: (edit: PolicyEdit) => void;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [rule, setRule] = useState<PersonalAgentAccess>("ask");
  const catalog = useMcpConnectionTools(connectionId, connectionId !== "");
  const available = catalog.data?.tools ?? [];
  const selected = available.filter((tool) => selection.includes(tool.name)).map((tool) => tool.name);
  return (
    <ActionDialog {...dialog} title="Add a tool rule" action="Save"
      disabled={selected.length === 0} onSave={() => onSave({ action: "tools", connectionId, toolNames: selected, rule })}>
      {connections.length ? <DenSelect aria-label="Connection" value={connectionId} disabled={dialog.busy}
        onChange={(event) => { setConnectionId(event.target.value); setSelection([]); }}>
        <option value="" disabled>Choose a connection</option>
        {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
      </DenSelect> : <Dialog.Description className={descriptionClass}>Add a connection before setting a tool rule.</Dialog.Description>}
      {connectionId ? <ToolRuleSelect label="Tool rule" value={rule} onChange={setRule} disabled={dialog.busy} /> : null}
      {connectionId && catalog.isPending ? <DenSkeleton className="h-20 w-full" /> : null}
      {connectionId && catalog.isError ? <div className="space-y-2">
        <DenNotice tone="error" message="Could not load these tools." />
        <DenButton variant="secondary" size="sm" onClick={() => void catalog.refetch()}>Try again</DenButton>
      </div> : null}
      {catalog.data && available.length === 0 ? <p className={descriptionClass}>This connection has no tools.</p> : null}
      {available.length > 0 ? <div aria-label="Tools" role="group" className="max-h-64 divide-y divide-[var(--dls-border)] overflow-y-auto">
        {available.map((tool) => <ToolCheckRow key={tool.name} tool={tool} disabled={dialog.busy}
          checked={selection.includes(tool.name)} onChange={(checked) => setSelection((current) => (
            checked ? [...current, tool.name] : current.filter((name) => name !== tool.name)
          ))} />)}
      </div> : null}
    </ActionDialog>
  );
}
