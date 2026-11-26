"use client";

import {
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Box,
  CalendarClock,
  ChevronRight,
  Download,
  FileText,
  LibraryBig,
  MessageCircle,
  MessageSquare,
  Plug,
  Repeat,
  ScrollText,
  Search,
  SlidersHorizontal,
  Sparkles,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { DenBadge } from "../../(den)/_components/ui/badge";
import { DenButton } from "../../(den)/_components/ui/button";
import { AUTOMATION_CARD_CLASS, DASHBOARD_PAGE_CLASS } from "../../(den)/_components/ui/dashboard-styles";
import { DenPageHeader } from "../../(den)/_components/ui/page-header";
import { DenSegmented, type DenSegmentedOption } from "../../(den)/_components/ui/segmented";
import { DenSelect } from "../../(den)/_components/ui/select";
import { DenSwitch } from "../../(den)/_components/ui/switch";
import { DenTable, type DenTableColumn } from "../../(den)/_components/ui/table";
import { UnderlineTabs, type TabItem } from "../../(den)/_components/ui/tabs";
import { peopleLabel } from "../../(den)/dashboard/_components/access-summary";
import { ItemSection } from "../../(den)/dashboard/_components/item-list";
import { ConnectorLogo, LetterTile } from "../../(den)/dashboard/_components/item-logo";
import { StatCard, StatStrip } from "../../(den)/dashboard/_features/analytics/stat-card";
import { formatWorkbotCost } from "../../(den)/dashboard/_features/workbot-usage/workbot-usage-data";
import {
  type Access,
  type Agent,
  type ConnectorId,
  type Level,
  type PaidBy,
  type Preset,
  BUDGET_DOLLARS,
  CONNECTORS,
  DOLLAR,
  MAX_AGENT_CHOICES,
  MEMBER,
  OTHER_PEOPLE,
  PRESET_LABEL,
  SHARED_USE,
  adminPreset,
  blocksForLevel,
  effectiveBudget,
  initialsOf,
  isMine,
  isShared,
  isWriteTool,
  listWords,
  modelById,
  personName,
  presetOf,
  runsLabel,
  shareTargets,
  sharedPeople,
  toolCount,
  toolLabel,
  toolsForLevel,
  usedByMe,
} from "./model";
import { Row } from "./parts";

// ---------------------------------------------------------------------------
// OpenWork Cloud (Den web), as an org admin sees it. Members never come here
// for their agents: they set them up in the OpenWork app. This is where an
// admin decides what every member's agent may do, and watches what they spend.
// ---------------------------------------------------------------------------

export type AdminTab = "rules" | "shared" | "spend";

// The admin is a different person from the member in the app, so the two views never blur.
export const ADMIN = { name: "Jo Okafor", initials: "JO" };

const ADMIN_TABS: TabItem<AdminTab>[] = [
  { value: "rules", label: "What agents may do" },
  { value: "shared", label: "Shared agents" },
  { value: "spend", label: "Spend" },
];

export type AdminDashboardProps = {
  tab: AdminTab;
  onTab: (tab: AdminTab) => void;
  agents: Agent[];
  access: Access;
  onAccess: (access: Access) => void;
  onPatchAgent: (id: string, patch: Partial<Agent>) => void;
};

export function AdminDashboard({ tab, onTab, agents, access, onAccess, onPatchAgent }: AdminDashboardProps) {
  return (
    <div data-den-shell="light" className="flex min-h-0 flex-1 flex-col bg-[var(--den-shell-canvas)] md:flex-row" data-testid="den-web">
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-[var(--den-shell-line)] bg-[var(--den-shell-sidebar)] md:flex">
        <div className="flex h-[52px] shrink-0 items-center border-b border-[var(--den-shell-line)] px-4">
          <img src="/openwork-mark.svg" alt="OpenWork" className="h-6 w-6" />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-5" aria-label="Workspace navigation">
          <div className="space-y-5">
            <SidebarGroup label="Work">
              <SidebarItem icon={LibraryBig} label="My Library" />
              <SidebarItem icon={CalendarClock} label="My Automations" />
            </SidebarGroup>
            <SidebarGroup label="Manage">
              <SidebarItem icon={Box} label="Plugins" />
              <SidebarItem icon={Plug} label="Connectors" badge="MCPs" />
              <SidebarItem icon={Sparkles} label="AI Gateway" />
              <SidebarItem icon={MessageCircle} label="Workbot" />
              <SidebarItem icon={Repeat} label="Agents" badge="Test" selected testId="den-nav-agents" />
            </SidebarGroup>
            <SidebarGroup label="Observability">
              <SidebarItem icon={BarChart3} label="Analytics" />
              <SidebarItem icon={ScrollText} label="Audit logs" />
            </SidebarGroup>
            <SidebarGroup label="Team">
              <SidebarItem icon={Users} label="Members" />
              <SidebarItem icon={SlidersHorizontal} label="Settings" />
            </SidebarGroup>
          </div>
        </nav>
        <div className="mt-auto shrink-0 border-t border-[var(--den-shell-line)] p-3">
          <div className="flex items-center justify-between gap-3 rounded-xl px-2 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#011627] text-[12px] font-semibold tracking-wider text-white">{ADMIN.initials}</span>
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-gray-900">Sample org</p>
                <p className="truncate text-[12px] text-gray-500" data-testid="den-role">{`${ADMIN.name} · Admin`}</p>
              </div>
            </div>
            <ArrowLeftRight className="h-4 w-4 shrink-0 text-gray-400" />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-[var(--den-shell-line)] bg-[var(--den-shell-topbar)] px-4 md:px-8">
          <div className="flex w-[280px] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-400">
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span>Search or jump to…</span>
            <kbd className="ml-auto font-mono text-[11px] text-gray-400">⌘K</kbd>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-gray-500 sm:inline-flex">
              <MessageSquare className="h-4 w-4" />
              Feedback
            </span>
            <span className="hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-gray-500 sm:inline-flex">
              <FileText className="h-4 w-4" />
              Docs
            </span>
            <DenButton size="sm" icon={Download}>Download OpenWork</DenButton>
          </div>
        </header>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className={`${DASHBOARD_PAGE_CLASS} flex flex-col gap-6`} data-testid="admin-agents">
            <DenPageHeader
              size="compact"
              title="Agents"
              state="Sample org · Admins only"
              description="Members set up their own agents in the OpenWork app. What you decide here applies to every one of them."
            />
            <UnderlineTabs tabs={ADMIN_TABS} activeTab={tab} onChange={onTab} />
            {tab === "rules" ? <AdminAccess access={access} onChange={onAccess} /> : null}
            {tab === "shared" ? <AdminShared agents={agents} access={access} onAccess={onAccess} onPatchAgent={onPatchAgent} /> : null}
            {tab === "spend" ? <AdminUsage agents={agents} access={access} /> : null}
          </div>
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell parts
// ---------------------------------------------------------------------------

function SidebarGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="px-3 pb-2 text-[11px] font-medium text-gray-500">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function SidebarItem({ icon: Icon, label, badge, selected = false, testId }: {
  icon: typeof LibraryBig;
  label: string;
  badge?: string;
  selected?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={selected ? "page" : undefined}
      className={`flex w-full min-w-0 items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] tracking-[-0.1px] transition-colors ${
        selected
          ? "bg-[var(--den-shell-nav-selected)] font-medium text-[color:var(--den-shell-nav-selected-ink)]"
          : "text-gray-500 hover:bg-[var(--den-shell-nav-hover)] hover:text-gray-700"
      }`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
        <span className="truncate">{label}</span>
      </span>
      {badge ? <span className="shrink-0 rounded-full border border-gray-200 bg-white px-1.5 py-0.5 text-[11px] font-medium leading-3 text-gray-600">{badge}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Admin: agents members shared with each other
// ---------------------------------------------------------------------------

function AdminShared({ agents, access, onAccess, onPatchAgent }: {
  agents: Agent[];
  access: Access;
  onAccess: (access: Access) => void;
  onPatchAgent: (id: string, patch: Partial<Agent>) => void;
}) {
  const shared = agents.filter((agent) => isShared(agent.share, agent.owner));
  const columns: DenTableColumn<Agent>[] = [
    {
      key: "name",
      header: "Agent",
      render: (agent) => (
        <span className="flex min-w-0 items-center gap-3">
          <LetterTile name={agent.name} />
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">
              <span className="truncate">{agent.name}</span>
              {agent.approved ? <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-label="Approved" /> : null}
            </span>
            <span className="truncate text-[12px] leading-4 text-[var(--dls-text-secondary)]">{`By ${personName(agent.owner)}`}</span>
          </span>
        </span>
      ),
    },
    {
      key: "who",
      header: "Shared with",
      render: (agent) => {
        const managers = agent.managers.length;
        return (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] leading-5 text-gray-900">{shareTargets(agent.share, agent.owner)}</span>
            <span className="truncate text-[12px] leading-4 text-gray-500">
              {agent.share.orgWide ? "The whole organization" : peopleLabel(sharedPeople(agent.share, agent.owner).length)}
              {managers > 0 ? ` · ${managers === 1 ? "1 manager" : `${managers} managers`}` : ""}
            </span>
          </span>
        );
      },
    },
    {
      key: "uses",
      header: "Can use",
      render: (agent) => {
        // What it asks for, inside what you allow. It always works with the accounts of whoever is using it.
        const uses = CONNECTORS.flatMap((connector) => {
          const allowed = agent.tools[connector.id].filter((tool) => !access.blocked[connector.id].includes(tool));
          return allowed.length > 0 ? [{ connector, allowed }] : [];
        });
        if (uses.length === 0) return <span className="text-[13px] text-gray-500">No apps</span>;
        return (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {uses.map(({ connector, allowed }) => {
              const preset = presetOf(connector, allowed);
              return (
                <span key={connector.id} className="inline-flex items-center gap-1.5 text-[12px] text-gray-600" title={listWords(allowed.map((tool) => toolLabel(tool).toLowerCase()))}>
                  <ConnectorLogo name={connector.name} url={connector.url} size="xs" />
                  {preset === "custom" ? toolCount(connector, allowed) : PRESET_LABEL[preset]}
                </span>
              );
            })}
          </span>
        );
      },
    },
    {
      key: "approved",
      header: "Approved",
      align: "right",
      render: (agent) => (
        <span className="flex justify-end">
          <DenSwitch size="sm" aria-label={`Mark ${agent.name} as approved`} checked={agent.approved} testId={`admin-approved-${agent.id}`}
            onChange={(approved) => onPatchAgent(agent.id, { approved })} />
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6" data-testid="admin-shared">
      <div className="w-full max-w-[760px]">
        <ItemSection title="Sharing" variant="rule" testId="admin-shared-rule">
          <div className="flex flex-col divide-y divide-gray-100">
            <Row label="Members can share agents" testId="admin-sharing-row"
              note={<span className="text-[12px] leading-4 text-gray-500">
                {access.sharing
                  ? "Any member can share an agent with people or teams. It works with each person's own accounts, and each person's use has its own budget."
                  : "Every agent stays with its owner. Agents shared before are hidden from everyone else until you turn this back on."}
              </span>}>
              <DenSwitch size="sm" aria-label="Members can share agents" checked={access.sharing} testId="admin-sharing"
                onChange={(sharing) => onAccess({ ...access, sharing })} />
            </Row>
          </div>
        </ItemSection>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">{access.sharing ? "Shared agents" : "Shared before you turned sharing off"}</h2>
          <p className="text-[12px] leading-4 text-[var(--dls-text-secondary)]">Members see a mark on the ones you approve.</p>
        </div>
        <div className={`${AUTOMATION_CARD_CLASS} overflow-hidden`} data-testid="admin-shared-list" data-sharing={access.sharing ? "on" : "off"}>
          <DenTable columns={columns} rows={shared} getRowKey={(agent) => agent.id} headerTone="plain" emptyLabel="No member has shared an agent yet." />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin: spend, with agents listed like people
// ---------------------------------------------------------------------------

type UsageFilter = "all" | "people" | "agents";
const ORG_BUDGET_DOLLARS = [100, 200, 500, 1000];
type UsageAgent = { id: string; name: string; detail: string; kind: string; spentMicro: number; budgetMicro: number | null; runs: number; paidBy: PaidBy };
type UsageRow = {
  key: string;
  kind: "person" | "agent";
  name: string;
  detail: string;
  kindLabel: string;
  activity: string;
  spentMicro: number;
  limitMicro: number | null;
  // Agents only: whose money a run spends.
  paidBy: PaidBy | null;
};

function AdminUsage({ agents, access }: { agents: Agent[]; access: Access }) {
  const [filter, setFilter] = useState<UsageFilter>("all");
  const mine = agents.filter(isMine);
  const payer = (paidBy: PaidBy) => access.orgBudget.offered ? paidBy : "me";
  // A shared agent is one agent, but each person's use of it is their own line.
  const people = [
    {
      id: "dana", name: MEMBER.name, ownSpendMicro: MEMBER.ownSpendMicro, requests: MEMBER.ownRequests, limitMicro: MEMBER.limitMicro,
      agents: [
        ...mine.map((agent): UsageAgent => ({
          id: agent.id, name: agent.name, detail: modelById(agent.model).label, kind: `Agent of ${MEMBER.name}`,
          spentMicro: agent.spentMicro, budgetMicro: effectiveBudget(agent, access), runs: agent.runsThisMonth, paidBy: payer(agent.paidBy),
        })),
        ...agents.filter((agent) => !isMine(agent) && usedByMe(agent)).map((agent): UsageAgent => ({
          id: `shared-${agent.id}`, name: agent.name, detail: `Shared by ${personName(agent.owner)}`, kind: `Shared agent, used by ${MEMBER.name}`,
          spentMicro: agent.spentMicro, budgetMicro: effectiveBudget(agent, access), runs: agent.runsThisMonth, paidBy: payer(agent.paidBy),
        })),
      ],
    },
    ...OTHER_PEOPLE.map((person) => ({
      id: person.id, name: person.name, ownSpendMicro: person.ownSpendMicro, requests: person.requests, limitMicro: person.limitMicro,
      agents: [
        ...person.agents.map((entry): UsageAgent => ({
          id: entry.id, name: entry.name, detail: entry.model, kind: `Agent of ${person.name}`,
          spentMicro: entry.spentMicro, budgetMicro: Math.min(entry.budgetMicro, access.agentCapMicro ?? entry.budgetMicro), runs: entry.runs, paidBy: payer(entry.paidBy),
        })),
        ...mine.flatMap((agent): UsageAgent[] => {
          const use = SHARED_USE[agent.id]?.[person.id];
          if (!use || !sharedPeople(agent.share, agent.owner).includes(person.id)) return [];
          return [{
            id: `shared-${agent.id}`, name: agent.name, detail: `Shared by ${MEMBER.name}`, kind: `Shared agent, used by ${person.name}`,
            spentMicro: use.spentMicro, budgetMicro: effectiveBudget(agent, access), runs: use.runs, paidBy: payer(agent.paidBy),
          }];
        }),
      ],
    })),
  ];
  const rows = people.flatMap((person): UsageRow[] => {
    const own = person.agents.filter((agent) => agent.paidBy === "me");
    const fromAgents = own.reduce((sum, agent) => sum + agent.spentMicro, 0);
    return [
      {
        key: person.id,
        kind: "person",
        name: person.name,
        detail: own.length > 0 ? `Includes ${formatWorkbotCost(fromAgents)} from ${own.length === 1 ? "1 agent" : `${own.length} agents`}` : "Own chats",
        kindLabel: "Member",
        activity: `${person.requests} requests`,
        spentMicro: person.ownSpendMicro + fromAgents,
        limitMicro: person.limitMicro,
        paidBy: null,
      },
      ...person.agents.map((agent): UsageRow => ({
        key: `${person.id}-${agent.id}`,
        kind: "agent",
        name: agent.name,
        detail: agent.detail,
        kindLabel: agent.kind,
        activity: runsLabel(agent.runs),
        spentMicro: agent.spentMicro,
        limitMicro: agent.budgetMicro,
        paidBy: agent.paidBy,
      })),
    ];
  });
  const agentRows = rows.filter((row) => row.kind === "agent");
  const agentSpend = agentRows.reduce((sum, row) => sum + row.spentMicro, 0);
  const allSpend = agentSpend + people.reduce((sum, person) => sum + person.ownSpendMicro, 0);
  const runs = people.reduce((sum, person) => sum + person.agents.reduce((count, agent) => count + agent.runs, 0), 0);
  const over = agentRows.filter((row) => row.limitMicro !== null && row.spentMicro >= row.limitMicro).length;
  const orgSpend = agentRows.filter((row) => row.paidBy === "org").reduce((sum, row) => sum + row.spentMicro, 0);
  const shown = rows.filter((row) => filter === "all" || (filter === "people" ? row.kind === "person" : row.kind === "agent")).sort((a, b) => (filter === "all" ? 0 : b.spentMicro - a.spentMicro));

  const columns: DenTableColumn<UsageRow>[] = [
    {
      key: "name",
      header: "Name",
      render: (row) => (
        <span className={`flex min-w-0 items-center gap-3 ${row.kind === "agent" && filter === "all" ? "pl-6" : ""}`}>
          {row.kind === "agent"
            ? <LetterTile name={row.name} />
            : <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#011627] text-[11px] font-semibold tracking-wider text-white">{initialsOf(row.name)}</span>}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">{row.name}</span>
            <span className="truncate text-[12px] leading-4 text-[var(--dls-text-secondary)]">{row.detail}</span>
          </span>
        </span>
      ),
    },
    { key: "owner", header: "Kind", render: (row) => <span className="text-[13px] text-gray-600">{row.kindLabel}</span> },
    { key: "paid", header: "Paid from", render: (row) => <span className="text-[13px] text-gray-600" data-paid-by={row.paidBy ?? "none"}>{row.paidBy === null ? "" : row.paidBy === "org" ? "Org agent budget" : "Their own limit"}</span> },
    { key: "activity", header: "This month", align: "right", render: (row) => <span className="text-[13px] tabular-nums text-gray-600">{row.activity}</span> },
    { key: "spend", header: "Spend", align: "right", render: (row) => <span className="font-mono text-[13px] tabular-nums text-gray-950">{formatWorkbotCost(row.spentMicro)}</span> },
    {
      key: "limit",
      header: "Limit",
      align: "right",
      render: (row) => row.limitMicro === null
        ? <span className="text-[13px] text-gray-500">None</span>
        : row.spentMicro >= row.limitMicro
          ? <DenBadge size="sm" tone="warning">{`Over ${formatWorkbotCost(row.limitMicro)}`}</DenBadge>
          : <span className="font-mono text-[13px] tabular-nums text-gray-600">{formatWorkbotCost(row.limitMicro)}</span>,
    },
  ];

  return (
    <div className="grid gap-6" data-testid="admin-usage">
      <StatStrip label="Agent spend this month" columns="grid-cols-2 lg:grid-cols-4">
        <StatCard title="Agents' spend" value={formatWorkbotCost(agentSpend)} sub={`${allSpend > 0 ? Math.round((agentSpend / allSpend) * 100) : 0}% of all spend`} />
        <StatCard title="Agents running" value={String(agentRows.length)} sub={`${people.filter((person) => person.agents.length > 0).length} members run one`} />
        {access.orgBudget.offered
          ? <StatCard title="Org agent budget" value={formatWorkbotCost(orgSpend)} sub={`of ${formatWorkbotCost(access.orgBudget.monthlyMicro)} this month`} />
          : <StatCard title="Runs" value={String(runs)} />}
        <StatCard title="Over budget" value={String(over)} sub={over > 0 ? "Paused until next month" : "None paused"} />
      </StatStrip>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]">People and agents</h2>
          <DenSegmented aria-label="Show" value={filter} onChange={setFilter}
            options={[{ value: "all", label: "By owner" }, { value: "people", label: "People" }, { value: "agents", label: "Agents" }]} optionTestId={(value) => `admin-usage-filter-${value}`} />
        </div>
        <div className={`${AUTOMATION_CARD_CLASS} overflow-hidden`}>
          <DenTable columns={columns} rows={shown} getRowKey={(row) => row.key} headerTone="plain" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin: what members' agents may do
// ---------------------------------------------------------------------------

function AdminAccess({ access, onChange }: { access: Access; onChange: (access: Access) => void }) {
  const [openId, setOpenId] = useState<ConnectorId | null>("gmail");
  const setBlocked = (id: ConnectorId, blocked: string[]) => onChange({ ...access, blocked: { ...access.blocked, [id]: blocked } });
  const options: DenSegmentedOption<Preset>[] = [
    { value: "none", label: "Not allowed" },
    { value: "read", label: PRESET_LABEL.read },
    { value: "write", label: PRESET_LABEL.write },
    { value: "custom", label: PRESET_LABEL.custom },
  ];
  return (
    <div className="flex w-full max-w-[760px] flex-col gap-6" data-testid="admin-access">
      <ItemSection title="What agents can use" variant="rule" testId="admin-access-connectors" meta="Members choose inside what you allow here">
        <div className="flex flex-col divide-y divide-gray-100">
          {CONNECTORS.map((connector) => {
            const blocked = access.blocked[connector.id];
            const preset = adminPreset(connector, blocked);
            const every = toolsForLevel(connector, "write");
            const open = openId === connector.id;
            const levelOf = (value: Preset): Level | null => value === "custom" ? null : value;
            return (
              <div key={connector.id} className="flex flex-col gap-1 py-2.5" data-testid={`admin-tools-${connector.id}`} data-level={preset} data-blocked={blocked.join(",")}>
                <div className="flex min-h-[40px] flex-wrap items-center justify-between gap-3">
                  <span className="flex min-w-[200px] flex-1 items-center gap-3">
                    <ConnectorLogo name={connector.name} url={connector.url} size="xs" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] font-medium text-gray-900">{connector.name}</span>
                      <span className="text-[12px] leading-4 text-gray-500">
                        {preset === "none" ? "No agent can use it."
                          : preset === "read" ? "Agents can read. They can't change anything."
                          : preset === "write" ? "Agents can read and write. They can't delete."
                          : `Blocked for every agent: ${listWords(blocked.map((tool) => toolLabel(tool).toLowerCase()))}.`}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <DenSegmented aria-label={`What agents can do in ${connector.name}`} value={preset} options={options} optionTestId={(value) => `admin-tools-${connector.id}-${value}`}
                      onChange={(value) => {
                        const level = levelOf(value);
                        if (level === null) setOpenId(connector.id);
                        else setBlocked(connector.id, blocksForLevel(connector, level));
                      }} />
                    <button type="button" onClick={() => setOpenId(open ? null : connector.id)} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${connector.name} tools`}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900" data-testid={`admin-tools-${connector.id}-toggle`}>
                      <ChevronRight className={`h-4 w-4 transition-transform duration-150 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden />
                    </button>
                  </span>
                </div>
                {open ? (
                  <div className="mt-1 flex flex-col pl-9" data-testid={`admin-tools-${connector.id}-list`}>
                    {every.map((tool) => {
                      const allowed = !blocked.includes(tool);
                      return (
                        <div key={tool} className="flex min-h-8 items-center justify-between gap-3 border-t border-gray-100 py-1" data-testid={`admin-tool-${connector.id}-${tool}`} data-state={allowed ? "allowed" : "blocked"}>
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className={`truncate text-[13px] leading-5 ${allowed ? "text-gray-900" : "text-gray-500"}`}>{toolLabel(tool)}</span>
                            <span className="shrink-0 text-[12px] leading-4 text-gray-500">{isWriteTool(connector, tool) ? "Writes" : "Reads"}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="text-[12px] leading-4 text-gray-500">{allowed ? "Members can allow it" : "Blocked for every agent"}</span>
                            <DenSwitch size="sm" aria-label={`Let agents ${toolLabel(tool).toLowerCase()} in ${connector.name}`} checked={allowed}
                              onChange={(next) => setBlocked(connector.id, next ? blocked.filter((entry) => entry !== tool) : every.filter((entry) => entry === tool || blocked.includes(entry)))} />
                          </span>
                        </div>
                      );
                    })}
                    <p className="border-t border-gray-100 pt-2 text-[12px] leading-4 text-gray-500">
                      {`Never allowed for any agent: ${listWords(connector.neverTools.map((tool) => toolLabel(tool).toLowerCase()))}. That isn't a setting.`}
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </ItemSection>
      <ItemSection title="Who pays" variant="rule" testId="admin-access-budget">
        <div className="flex flex-col divide-y divide-gray-100">
          <Row label="Offer an org budget for agents" testId="admin-org-budget"
            note={<span className="text-[12px] leading-4 text-gray-500">{access.orgBudget.offered ? "Members can charge an agent to this budget instead of their own limit." : "Every agent counts toward its owner's own limit."}</span>}>
            <DenSwitch size="sm" aria-label="Offer an org budget for agents" checked={access.orgBudget.offered} testId="admin-org-budget-offered"
              onChange={(offered) => onChange({ ...access, orgBudget: { ...access.orgBudget, offered } })} />
          </Row>
          {access.orgBudget.offered ? (
            <Row label="Org agent budget">
              <div className="w-48">
                <DenSelect size="sm" aria-label="Org agent budget" menuWidth="trigger" value={String(access.orgBudget.monthlyMicro / DOLLAR)}
                  onChange={(event) => onChange({ ...access, orgBudget: { ...access.orgBudget, monthlyMicro: Number(event.target.value) * DOLLAR } })}>
                  {ORG_BUDGET_DOLLARS.map((dollars) => <option key={dollars} value={String(dollars)}>{`${formatWorkbotCost(dollars * DOLLAR)} a month`}</option>)}
                </DenSelect>
              </div>
            </Row>
          ) : null}
        </div>
      </ItemSection>
      <ItemSection title="Limits" variant="rule" testId="admin-access-limits">
        <div className="flex flex-col divide-y divide-gray-100">
          <Row label="Most an agent can spend in a month">
            <div className="w-48">
              <DenSelect size="sm" aria-label="Most an agent can spend in a month" menuWidth="trigger" value={access.agentCapMicro === null ? "none" : String(access.agentCapMicro / DOLLAR)}
                onChange={(event) => onChange({ ...access, agentCapMicro: event.target.value === "none" ? null : Number(event.target.value) * DOLLAR })}>
                {BUDGET_DOLLARS.map((dollars) => <option key={dollars} value={String(dollars)}>{formatWorkbotCost(dollars * DOLLAR)}</option>)}
                <option value="none">No limit</option>
              </DenSelect>
            </div>
          </Row>
          <Row label="Agents for each member">
            <div className="w-48">
              <DenSelect size="sm" aria-label="Agents for each member" menuWidth="trigger" value={String(access.maxAgents)} onChange={(event) => onChange({ ...access, maxAgents: Number(event.target.value) })}>
                {MAX_AGENT_CHOICES.map((count) => <option key={count} value={String(count)}>{`Up to ${count}`}</option>)}
              </DenSelect>
            </div>
          </Row>
          <Row label="Runs at once for each agent">
            <div className="w-48">
              <DenSelect size="sm" aria-label="Runs at once for each agent" menuWidth="trigger" value={String(access.atOnce)} onChange={(event) => onChange({ ...access, atOnce: Number(event.target.value) })}>
                {[1, 2, 3, 5].map((count) => <option key={count} value={String(count)}>{`${count} at once`}</option>)}
              </DenSelect>
            </div>
          </Row>
          <Row label="Where agents work">
            <div className="w-48">
              <DenSelect size="sm" aria-label="Where agents work" menuWidth="trigger" value={access.cloudOnly ? "cloud" : "any"} onChange={(event) => onChange({ ...access, cloudOnly: event.target.value === "cloud" })}>
                <option value="any">Cloud or computers</option>
                <option value="cloud">Cloud only</option>
              </DenSelect>
            </div>
          </Row>
        </div>
      </ItemSection>
    </div>
  );
}
