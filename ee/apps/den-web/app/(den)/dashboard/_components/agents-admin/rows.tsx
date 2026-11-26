import { Menu } from "@base-ui/react/menu";
import type { PersonalAgentAdminItem, PersonalAgentSpend } from "@openwork/types/den/personal-agents";
import { Ellipsis } from "lucide-react";
import { useRef, useState } from "react";
import { DenBadge } from "../../../_components/ui/badge";
import { buttonVariants } from "../../../_components/ui/button";
import { denDropdownMenuBaseClass } from "../../../_components/ui/dropdown-styles";
import { DenUsageMeter } from "../../../_components/ui/usage-meter";
import type { DenOrgContext } from "../../../_lib/den-org";
import { formatRelativeTime } from "../config-blobs/config-blobs-model";
import { AccessDialog } from "./access-dialog";
import { AgentNotSharedError, useEditAdminAgent, type AgentEdit } from "./data";
import { AgentChangeDialog, type AgentDialogKind } from "./dialogs";
import { agentAccess, agentFaceColor, formatAgentMoney, latestAgentRun, notSharedReason, runStatusText, writeAccessText } from "./words";

const cells = "px-3 py-2.5 align-middle";
const headings = ["Agent", "Owner", "Access", "Can change things", "This month", "Last run", "Actions"];
const muted = "text-[var(--dls-text-secondary)]";
type AgentOrg = Pick<DenOrgContext, "organization" | "members" | "teams">;

function SpendCell({ spend }: { spend: PersonalAgentSpend }) {
  const { monthMicros, budgetMicros, overBudget } = spend;
  const amount = formatAgentMoney(monthMicros);
  const segments = 10;
  const used = budgetMicros && !overBudget ? Math.ceil(monthMicros / budgetMicros * segments) : segments;
  return <div className="grid justify-items-start gap-1 whitespace-nowrap tabular-nums">
    {budgetMicros === null ? <span>{amount}</span> : <DenUsageMeter label="" used={used} total={segments}
      readout={`${amount} of ${formatAgentMoney(budgetMicros)}`} className="w-full" />}
    {overBudget ? <DenBadge tone="danger" size="sm">Over budget</DenBadge> : null}
  </div>;
}

function AgentRow({ org, item, now }: { org: AgentOrg; item: PersonalAgentAdminItem; now: number }) {
  const [dialog, setDialog] = useState<AgentDialogKind | "access" | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const edit = useEditAdminAgent(org.organization.id, item.agent.id);
  const audience = {
    ...item.audience,
    teams: item.audience.teams.map((team) => ({ ...team, name: org.teams.find(({ id }) => id === team.teamId)?.name ?? team.name })),
  };
  const access = agentAccess({ ...item, audience }, org.organization.name);
  const dialogProps = {
    finalFocus: trigger,
    busy: edit.isPending,
    error: edit.error instanceof AgentNotSharedError ? notSharedReason : edit.isError ? "Could not save this change. Try again." : null,
    onClose: () => { edit.reset(); setDialog(null); },
  };
  const { name, pausedAt } = item.agent;
  const lastRun = latestAgentRun(item.routines);
  const pauseAction = pausedAt === null ? "pause" : "resume";
  const actions = [
    { action: pauseAction, label: pauseAction === "pause" ? "Pause" : "Resume", select: () => edit.mutate({ action: pauseAction }) },
    { action: "access", label: "Change access…", reason: access.notShared ? notSharedReason : undefined, select: () => open("access") },
    { action: "budget", label: "Set budget…", select: () => open("budget") },
    { action: "transfer", label: "Move to another owner…", select: () => open("transfer") },
    { action: "archive", label: "Archive…", select: () => open("archive") },
  ];

  function open(kind: AgentDialogKind | "access") {
    edit.reset();
    setDialog(kind);
  }

  function save(change: AgentEdit) {
    edit.mutate(change, { onSuccess: () => setDialog(null) });
  }

  return <tr data-agent-row={name}>
    <th scope="row" className={`${cells} font-medium`}>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${agentFaceColor(name)}`}>{Array.from(name)[0]?.toLocaleUpperCase()}</span>
        <div className="min-w-0">
          <div className="break-words">{name}</div>
          {pausedAt !== null ? <DenBadge size="sm">Paused</DenBadge> : null}
        </div>
      </div>
    </th>
    <td className={cells}>{item.owner.name || "Unnamed member"}</td>
    <td className={cells}>
      <div className={access.notShared ? muted : undefined}>{access.text}</div>
      {access.addedToSidebar ? <div className={muted}>Added to sidebar</div> : null}
    </td>
    <td className={cells}>{writeAccessText(item.writeAccess)}</td>
    <td className={cells}><SpendCell spend={item.spend} /></td>
    <td className={cells}>{lastRun ? <>
      <time dateTime={new Date(lastRun.createdAt).toISOString()} className="whitespace-nowrap">{formatRelativeTime(new Date(lastRun.createdAt).toISOString(), now)}</time>
      <div className="text-[var(--dls-text-secondary)]">{runStatusText[lastRun.status]}</div>
    </> : "Not yet"}</td>
    <td className={`${cells} text-right`}>
      <Menu.Root>
        <Menu.Trigger ref={trigger} data-agent-menu="" aria-label={`Actions for ${name}`} disabled={edit.isPending}
          className={buttonVariants({ variant: "ghost", size: "inline", className: "w-8" })}>
          <Ellipsis size={16} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Menu.Popup className={`${denDropdownMenuBaseClass} w-max overflow-y-auto p-1 text-[13px]`}>
              {actions.map(({ action, label, reason, select }) => <Menu.Item key={action} data-agent-action={action} disabled={Boolean(reason)} onClick={select}
                className={`rounded-md px-3 py-2 outline-hidden data-highlighted:bg-gray-100 ${reason ? `cursor-not-allowed ${muted}` : "cursor-pointer"} ${action === "archive" ? "text-red-600" : ""}`}>
                {label}
                {reason ? <div className="text-xs">{reason}</div> : null}
              </Menu.Item>)}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {!dialog && edit.isError ? <p role="alert" className="text-xs text-red-600">Could not {pauseAction}. Try again.</p> : null}
      {dialog === "access" ? <AccessDialog {...dialogProps} item={item} orgName={org.organization.name} teams={org.teams}
        onSave={(audience) => save({ action: "audience", audience })} />
        : dialog ? <AgentChangeDialog {...dialogProps} kind={dialog} item={item} members={org.members} onSave={save} /> : null}
    </td>
  </tr>;
}

export function AgentTable({ org, items }: { org: AgentOrg; items: readonly PersonalAgentAdminItem[] }) {
  const now = Date.now();
  if (!items.length) return <p className="border-y border-[var(--dls-border)] py-5 text-[13px] text-[var(--dls-text-secondary)]">
    No agents yet. Members make them from the + beside Agents in the OpenWork app.
  </p>;
  return <div className="overflow-x-auto">
    <table aria-label="Personal agents" className="w-full text-left text-[13px]">
      <thead className="border-b border-[var(--dls-border)] text-xs text-[var(--dls-text-secondary)]">
        <tr>{headings.map((label) => <th key={label} scope="col" className={`${cells} font-medium`}>
          <span className={label === "Actions" ? "sr-only" : undefined}>{label}</span>
        </th>)}</tr>
      </thead>
      <tbody className="divide-y divide-[var(--dls-border)] border-b border-[var(--dls-border)]">
        {items.map((item) => <AgentRow key={item.agent.id} org={org} item={item} now={now} />)}
      </tbody>
    </table>
  </div>;
}
