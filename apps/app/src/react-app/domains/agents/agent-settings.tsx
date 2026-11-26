import type { PersonalAgentAccess, PersonalAgentConnectionTools, PersonalAgentDetail, PersonalAgentSpend, PersonalAgentTool } from "@openwork/types/den/personal-agents";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Lock } from "lucide-react";
import { useId, useState } from "react";

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { currentLocale, t } from "@/i18n";

import { agentOwnerFirstName, agentSpendLine, formatAgentMoney, toolAccessSummary, toolControlState } from "./agent-permission-words";
import { firstName } from "./agent-words";
import type { AgentsRuntime } from "./agents-runtime";
import { useAgentToolsQuery, useSaveAgentSettings, useShareAgentLogin } from "./use-agent-permissions";

import { agentsQueryRoot, pendingRoutineMessage } from "./use-agents";

const BUDGET_OPTIONS = [5_000_000, 10_000_000, 25_000_000, 50_000_000];
const NO_BUDGET = "none";

type ToolRowProps = {
  tool: PersonalAgentTool;
  lockReason: string | null;
  connectionBlocked: boolean;
  saving: boolean;
  sentMessage?: string;
  onChange: (access: PersonalAgentAccess) => void;
};

function ToolRow({ tool, lockReason, connectionBlocked, saving, sentMessage, onChange }: ToolRowProps) {
  const titleId = useId();
  const reasonId = useId();
  const control = toolControlState(tool, connectionBlocked);
  const reason = [lockReason, control.hint].filter(Boolean).join(" ");
  return (
    <li data-agent-tool={tool.name} className="border-t border-dls-border py-1.5">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span id={titleId} className="min-w-0 wrap-anywhere text-xs text-dls-text">{tool.title}</span>
        <ToggleGroup
          aria-labelledby={titleId}
          aria-describedby={reason ? reasonId : undefined}
          variant="segmented"
          size="xs"
          spacing={1}
          className="shrink-0"
          disabled={Boolean(lockReason)}
          aria-disabled={saving || undefined}
          value={[control.access]}
          onValueChange={([value]) => {
            if (saving || lockReason) return;
            if (value === "allow" && control.allowDisabled) return;
            if (value === "allow" || value === "ask" || value === "block") onChange(value);
            else if (tool.chosen === null && !control.hint) onChange(control.access);
          }}
        >
          <ToggleGroupItem value="allow" disabled={control.allowDisabled} data-agent-tool-access="allow" className="px-1.5">{t("agents.permissions_allow")}</ToggleGroupItem>
          <ToggleGroupItem value="ask" data-agent-tool-access="ask" className="px-1.5">{t("agents.permissions_ask")}</ToggleGroupItem>
          <ToggleGroupItem value="block" data-agent-tool-access="block" className="px-1.5">{t("agents.permissions_block")}</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {reason && <p id={reasonId} className="mt-1 flex items-center gap-1.5 text-xs text-dls-secondary">{lockReason && <Lock aria-hidden="true" className="size-3 shrink-0" />}{reason}</p>}
      {sentMessage && <p role="status" className="mt-1 text-xs text-dls-secondary">{sentMessage}</p>}
    </li>
  );
}

function ConnectionRow({ connection, collaboratorReason, sentTool, saving, memberId, onShare, onChange }: {
  connection: PersonalAgentConnectionTools;
  collaboratorReason: string | null;
  sentTool: { name: string; message: string } | null;
  memberId: string | null;
  onShare: (shared: boolean) => void;
  saving: boolean;
  onChange: (toolName: string, access: PersonalAgentAccess) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toolsId = useId();
  const sharedLabelId = useId();
  const summary = (
    <span className="min-w-0 flex-1">
      <span className="block wrap-anywhere text-[13px] font-medium text-dls-text">{connection.name}</span>
      <span className="block text-xs text-dls-secondary">{connection.sharedLogin
        ? t("agents.permissions_shared_account", { name: firstName(connection.sharedLogin.name) })
        : t("agents.permissions_own_accounts")}</span>
      <span className="block text-xs text-dls-secondary">{toolAccessSummary(connection)}</span>
    </span>
  );

  return (
    <div data-agent-connection={connection.name} className="border-t border-dls-border">
      {connection.tools.length > 0 ? (
        <button
          type="button"
          data-agent-connection-toggle
          aria-expanded={expanded}
          aria-controls={toolsId}
          onClick={() => setExpanded((value) => !value)}
          className="group flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 text-start focus-visible:outline-2 focus-visible:outline-ring"
        >
          {summary}
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-dls-secondary transition-transform group-aria-expanded:rotate-90" />
        </button>
      ) : <div className="flex min-h-11 items-center py-1.5">{summary}</div>}
      {connection.canShareLogin && (
        <div className="flex min-h-10 items-center justify-between gap-3 pb-1 pe-2">
          <span id={sharedLabelId} className="text-xs">{t("agents.permissions_share_login")}</span>
          <Switch size="sm" aria-labelledby={sharedLabelId} data-agent-shared-login={connection.name}
            disabled={saving || Boolean(connection.sharedLogin && !memberId)}
            checked={connection.sharedLogin != null && connection.sharedLogin.memberId === memberId}
            onCheckedChange={onShare} />
        </div>
      )}
      <div id={toolsId} hidden={!expanded}>
        {expanded && [false, true].map((write) => {
          const tools = connection.tools.filter((tool) => tool.write === write);
          if (!tools.length) return null;
          return (
            <div key={String(write)} className="pb-1 pl-2.5">
              <h4 className="pb-1 pt-1.5 text-xs font-medium text-dls-secondary">{write ? t("agents.permissions_changes") : t("agents.permissions_reads")}</h4>
              <ul>
                {tools.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    tool={tool}
                    lockReason={tool.lockedByOrganization || connection.lockedByOrganization
                      ? t("agents.permissions_admin_blocked")
                      : collaboratorReason ?? (connection.blocked ? t("agents.permissions_connection_blocked") : null)}
                    connectionBlocked={connection.blocked || connection.lockedByOrganization}
                    saving={saving}
                    sentMessage={sentTool?.name === tool.name ? sentTool.message : undefined}
                    onChange={(access) => onChange(tool.name, access)}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Spend({ spend }: { spend: PersonalAgentSpend }) {
  const { budgetMicros, monthMicros, unpricedTokens, overBudget } = spend;
  const line = agentSpendLine(spend);
  return (
    <section className="space-y-1.5 border-t border-dls-border pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <h3 className="text-[13px] font-medium">{t("agents.permissions_spend")}</h3>
        <p className="text-xs tabular-nums text-dls-secondary">{line}</p>
      </div>
      {budgetMicros === null
        ? <div aria-hidden="true" className="h-1 rounded-full bg-muted" />
        : <Progress aria-label={t("agents.permissions_spend")} aria-valuetext={line} value={budgetMicros === 0 ? 100 : Math.min(100, monthMicros / budgetMicros * 100)} className="gap-0 [&_[data-slot=progress-track]]:h-1" />}
      {unpricedTokens > 0 ? <p className="text-xs text-dls-secondary">{t("agents.permissions_unpriced", { tokens: new Intl.NumberFormat(currentLocale()).format(unpricedTokens) })}</p> : null}
      {overBudget ? <p className="text-xs text-dls-secondary">{t("agents.permissions_over_budget")}</p> : null}
    </section>
  );
}

function budgetLabel(amount: number | null): string {
  return amount === null ? t("agents.permissions_no_budget") : formatAgentMoney(amount, BUDGET_OPTIONS.includes(amount) ? 0 : 2);
}

function MonthlyBudget({ owner, budget, adminBudget, saving, onChange }: {
  owner: boolean;
  budget: number | null;
  adminBudget: number | null;
  saving: boolean;
  onChange: (amount: number | null) => void;
}) {
  const labelId = useId();
  const capsBudget = adminBudget !== null && (budget === null || adminBudget < budget);
  const options = budget !== null && !BUDGET_OPTIONS.includes(budget) ? [...BUDGET_OPTIONS, budget].sort((a, b) => a - b) : BUDGET_OPTIONS;
  const items = [{ value: NO_BUDGET, label: budgetLabel(null) }, ...options.map((amount) => ({ value: String(amount), label: budgetLabel(amount) }))];
  return (
    <section className="border-t border-dls-border pt-1.5">
      <div className="flex min-h-10 items-center justify-between gap-2">
        <h3 id={labelId} className="text-[13px] font-medium">{t("agents.permissions_budget")}</h3>
        {owner ? (
          <Select
            items={items}
            value={budget === null ? NO_BUDGET : String(budget)}
            disabled={saving}
            onValueChange={(value) => {
              if (value !== null) onChange(value === NO_BUDGET ? null : Number(value));
            }}
          >
            <SelectTrigger aria-labelledby={labelId} size="sm" className="text-xs"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : <p className="text-xs tabular-nums text-dls-secondary">{budgetLabel(budget)}</p>}
      </div>
      {capsBudget ? <p className="pt-1 text-xs text-dls-secondary">{t("agents.permissions_admin_budget", { amount: formatAgentMoney(adminBudget) })}</p> : null}
    </section>
  );
}

export function AgentSettings({ runtime, agent, onBack }: { runtime: AgentsRuntime; agent: PersonalAgentDetail; onBack: () => void }) {
  const catalog = useAgentToolsQuery(runtime, agent.agent.id);
  const save = useSaveAgentSettings(runtime, agent);
  const share = useShareAgentLogin(runtime, agent.agent.id);
  const [confirm, setConfirm] = useState<PersonalAgentConnectionTools | null>(null);
  const directory = useQuery({
    queryKey: [...agentsQueryRoot(runtime), "directory"],
    queryFn: () => runtime.client.getLibraryOrgDirectory(runtime.organizationId),
    enabled: agent.role === "manager" && Boolean(catalog.data?.connections.some((connection) => connection.canShareLogin && connection.sharedLogin)),
    staleTime: 60_000,
  });
  const memberId = agent.role === "owner" ? agent.agent.ownerMemberId : directory.data?.currentMemberId ?? null;
  const collaboratorReason = agent.role === "collaborator"
    ? t("agents.permissions_collaborator", { owner: agentOwnerFirstName(agent.owner) })
    : null;
  const budget = save.isPending && "monthlyBudgetMicros" in save.variables ? save.variables.monthlyBudgetMicros : agent.revision.monthlyBudgetMicros;
  const sentTool = save.data && "request" in save.data && save.variables && "tool" in save.variables ? save.variables.tool : null;
  const ownerName = firstName(agent.owner?.name);

  return (
    <div data-agent-settings className="flex h-full min-h-0 flex-col text-dls-text">
      <header className="flex min-h-10 shrink-0 items-center gap-1.5 border-b border-dls-border">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("common.back")} data-agent-settings-back onClick={onBack}>
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Button>
        <h2 className="text-sm font-medium">{t("agents.permissions_settings")}</h2>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-2 pt-3">
        <section>
          <h3 className="text-[13px] font-medium">{t("agents.permissions_tools")}</h3>
          <p className="pb-2 pt-1 text-xs text-dls-secondary">{t("agents.permissions_defaults")}</p>
          {agent.role === "manager" && <p className="pb-2 text-xs text-dls-secondary">{ownerName
            ? t("agents.permissions_owner_approves", { name: ownerName })
            : t("agents.permissions_the_owner_approves")}</p>}
          {catalog.isPending ? <p role="status" className="pb-1 text-xs text-dls-secondary">{t("agents.permissions_loading")}</p> : null}
          {catalog.isError && !catalog.data ? (
            <div className="flex items-center justify-between gap-2 pb-1">
              <p role="status" className="text-xs text-dls-secondary">{t("agents.permissions_load_failed")}</p>
              <Button type="button" variant="ghost" size="sm" onClick={() => { void catalog.refetch(); }}>{t("common.retry")}</Button>
            </div>
          ) : null}
          {catalog.data?.connections.length === 0 ? <p className="pb-1 text-xs text-dls-secondary">{t("agents.permissions_no_connections")}</p> : null}
          {catalog.data?.connections.map((connection) => (
            <ConnectionRow
              key={connection.connectionId}
              connection={connection}
              collaboratorReason={collaboratorReason}
              sentTool={sentTool?.connectionId === connection.connectionId ? { name: sentTool.toolName, message: pendingRoutineMessage(agent.owner) } : null}
              saving={save.isPending || share.isPending}
              memberId={memberId}
              onShare={(shared) => {
                if (shared) setConfirm(connection);
                else share.mutate({ connectionId: connection.connectionId, shared });
              }}
              onChange={(toolName, access) => save.mutate({ tool: { connectionId: connection.connectionId, toolName, access } })}
            />
          ))}
        </section>
        <Spend spend={agent.spend} />
        <MonthlyBudget
          owner={agent.role === "owner"}
          budget={budget}
          adminBudget={agent.spend.adminBudgetMicros}
          saving={save.isPending}
          onChange={(monthlyBudgetMicros) => save.mutate({ monthlyBudgetMicros })}
        />
        <p className="border-t border-dls-border pt-2.5 text-xs text-dls-secondary">{t("agents.permissions_next_run")}</p>
      </div>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        {confirm && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("agents.permissions_share_login_title", { connection: confirm.name })}</AlertDialogTitle>
              <AlertDialogDescription>{t("agents.permissions_share_login_body", { agent: agent.agent.name, connection: confirm.name })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => {
                share.mutate({ connectionId: confirm.connectionId, shared: true });
                setConfirm(null);
              }}>{t("agents.permissions_share_login_confirm")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}
