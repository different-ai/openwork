"use client";

import {
  Bell,
  Brain,
  ChevronRight,
  DollarSign,
  Gauge,
  Search,
  Users
} from "lucide-react";
import { useMemo, useState } from "react";
import { OpenWorkMark } from "./openwork-mark";

type DepartmentCategory = "Technical teams" | "Business teams";

type Department = {
  name: string;
  category: DepartmentCategory;
  dailyActive: string;
  spend: string;
  avgPerPerson: string;
  powerUsers: string[];
};

type ToolRow = {
  tool: string;
  penetration: string;
  dailyActiveUsers: string;
  topDepartments: string;
  commonModels: string;
};

type PowerUser = {
  name: string;
  initials: string;
  department: string;
  topTool: string;
  trend: number[];
  requests: string;
  inputTokens: string;
  outputTokens: string;
  cost: string;
};

const departments: Department[] = [
  {
    name: "Engineering",
    category: "Technical teams",
    dailyActive: "32 / 54",
    spend: "$210K",
    avgPerPerson: "$4.4K",
    powerUsers: ["JC", "LT", "GH", "+3"]
  },
  {
    name: "Data Science",
    category: "Technical teams",
    dailyActive: "16 / 28",
    spend: "$120K",
    avgPerPerson: "$4.3K",
    powerUsers: ["AL", "MC", "AT", "+2"]
  },
  {
    name: "Product",
    category: "Technical teams",
    dailyActive: "9 / 24",
    spend: "$90K",
    avgPerPerson: "$3.8K",
    powerUsers: ["HL", "DG", "AR", "+1"]
  },
  {
    name: "Customer Support",
    category: "Business teams",
    dailyActive: "7 / 36",
    spend: "$30K",
    avgPerPerson: "$968",
    powerUsers: ["MF", "SG", "RM", "+2"]
  },
  {
    name: "Marketing",
    category: "Business teams",
    dailyActive: "3 / 28",
    spend: "$18K",
    avgPerPerson: "$643",
    powerUsers: ["RF", "AS", "JR", "+1"]
  },
  {
    name: "Sales",
    category: "Business teams",
    dailyActive: "1 / 25",
    spend: "$15K",
    avgPerPerson: "$600",
    powerUsers: ["AC", "WB", "HF", "+2"]
  },
  {
    name: "Legal",
    category: "Business teams",
    dailyActive: "0 / 12",
    spend: "$7K",
    avgPerPerson: "$583",
    powerUsers: ["SD", "OB", "RH", "+1"]
  }
];

const toolRows: ToolRow[] = [
  {
    tool: "OpenWork",
    penetration: "41%",
    dailyActiveUsers: "54",
    topDepartments: "Customer Support, Marketing, Product",
    commonModels: "Kimi K2.5, GPT-5.4 Fast, Opus 4.7, GLM-5.1"
  },
  {
    tool: "Cursor",
    penetration: "24%",
    dailyActiveUsers: "32",
    topDepartments: "Engineering, Data Science",
    commonModels: "Opus 4.7, Sonnet, GPT-5.4"
  },
  {
    tool: "Figma AI",
    penetration: "11%",
    dailyActiveUsers: "14",
    topDepartments: "Product, Marketing",
    commonModels: "GPT-5.4 Fast, Sonnet"
  },
  {
    tool: "Notion AI",
    penetration: "9%",
    dailyActiveUsers: "12",
    topDepartments: "Product, Marketing, Legal",
    commonModels: "GPT-5.4 Fast, Sonnet"
  },
  {
    tool: "Zendesk AI",
    penetration: "7%",
    dailyActiveUsers: "9",
    topDepartments: "Customer Support",
    commonModels: "Kimi K2.5, GLM-5.1"
  }
];

const powerUsers: PowerUser[] = [
  {
    name: "John Carmack",
    initials: "JC",
    department: "Engineering",
    topTool: "Cursor",
    trend: [14, 16, 18, 17, 22, 25, 28, 34],
    requests: "1.4K",
    inputTokens: "820K",
    outputTokens: "310K",
    cost: "$1.2K"
  },
  {
    name: "Linus Torvalds",
    initials: "LT",
    department: "Engineering",
    topTool: "Cursor",
    trend: [10, 12, 14, 16, 18, 20, 22, 26],
    requests: "1.1K",
    inputTokens: "640K",
    outputTokens: "250K",
    cost: "$910"
  },
  {
    name: "Ada Lovelace",
    initials: "AL",
    department: "Data Science",
    topTool: "OpenWork",
    trend: [7, 9, 11, 13, 12, 15, 18, 22],
    requests: "960",
    inputTokens: "540K",
    outputTokens: "210K",
    cost: "$780"
  },
  {
    name: "Alan Turing",
    initials: "AT",
    department: "Data Science",
    topTool: "OpenWork",
    trend: [8, 10, 11, 13, 15, 16, 18, 20],
    requests: "880",
    inputTokens: "500K",
    outputTokens: "200K",
    cost: "$690"
  },
  {
    name: "Grace Hopper",
    initials: "GH",
    department: "Engineering",
    topTool: "OpenWork",
    trend: [5, 7, 9, 10, 12, 13, 15, 18],
    requests: "720",
    inputTokens: "410K",
    outputTokens: "180K",
    cost: "$560"
  },
  {
    name: "Marie Curie",
    initials: "MC",
    department: "Data Science",
    topTool: "OpenWork",
    trend: [6, 7, 9, 10, 12, 13, 14, 16],
    requests: "680",
    inputTokens: "380K",
    outputTokens: "170K",
    cost: "$520"
  },
  {
    name: "Andrew Carnegie",
    initials: "AC",
    department: "Sales",
    topTool: "OpenWork",
    trend: [3, 4, 5, 6, 7, 8, 10, 11],
    requests: "510",
    inputTokens: "290K",
    outputTokens: "140K",
    cost: "$420"
  },
  {
    name: "Warren Buffett",
    initials: "WB",
    department: "Sales",
    topTool: "OpenWork",
    trend: [2, 3, 4, 5, 5, 6, 7, 9],
    requests: "430",
    inputTokens: "240K",
    outputTokens: "115K",
    cost: "$360"
  }
];

type TabId = "departments" | "tools";

type Props = {
  /** When true, the outer card renders its own rounded border + shadow. When false, the caller wraps it. */
  standalone?: boolean;
};

export function LandingEnterpriseHero({ standalone = false }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("departments");
  const [selectedDepartment, setSelectedDepartment] = useState<string | null>(
    null
  );
  const [selectedTool, setSelectedTool] = useState<string | null>("OpenWork");

  const visibleTools = useMemo(() => {
    if (!selectedDepartment) return toolRows;
    return toolRows.filter((row) =>
      row.topDepartments
        .split(",")
        .map((s) => s.trim())
        .includes(selectedDepartment)
    );
  }, [selectedDepartment]);

  const shell = standalone
    ? "overflow-hidden rounded-[28px] border border-[#dde2ea] bg-[#fbfbfa] shadow-[0_18px_60px_rgba(7,25,44,0.08)]"
    : "overflow-hidden bg-[#fbfbfa]";

  return (
    <div className={shell}>
      <MacChrome />

      <div className="relative border-t border-[#e7e9f0] px-4 pb-6 pt-4 sm:px-6 md:px-10 md:pb-9 md:pt-6">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[220px] bg-[radial-gradient(circle_at_88%_20%,rgba(122,92,255,0.12),transparent_26%),radial-gradient(circle_at_98%_28%,rgba(255,143,71,0.08),transparent_16%)]" />

        <TopNav />

        <header className="relative z-10 mt-5 md:mt-6">
          <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium tracking-[-0.01em] text-[#07192C] md:gap-3 md:text-[15px]">
            <span className="inline-flex items-center rounded-[8px] bg-[#F8E8D7] px-2.5 py-1 text-[12px] font-semibold text-[#E56A17] md:px-3">
              Q2
            </span>
            <span>AI Adoption</span>
            <ChevronRight className="h-3.5 w-3.5 text-[#637291]" />
            <span>
              {activeTab === "departments"
                ? "Department view"
                : "Tools view"}
            </span>
          </div>

          <p className="mt-2 text-[13px] leading-6 text-[#5A6886] md:text-[15px] md:leading-7">
            {activeTab === "departments"
              ? "See where AI usage is concentrated across departments and who's driving it."
              : "Rank every tool that has been used at least once in the last 30 days."}
          </p>
        </header>

        <div className="relative z-10 mt-5 grid gap-3 md:mt-6 md:grid-cols-3 md:gap-4">
          <StatCard
            icon={<Users className="h-6 w-6 text-[#6F3DFF]" />}
            title="Daily active AI users"
            value="68 / 131"
            tone="violet"
          />
          <StatCard
            icon={<DollarSign className="h-6 w-6 text-[#18A34A]" />}
            title="Monthly spend"
            value="$480K"
            tone="green"
          />
          <StatCard
            icon={<Gauge className="h-6 w-6 text-[#1D63FF]" />}
            title="Top-tool penetration"
            value="41%"
            subvalue="OpenWork · 54 users"
            tone="blue"
          />
        </div>

        <div className="relative z-10 mt-5 md:mt-6">
          <TabBar activeTab={activeTab} onChange={setActiveTab} />
        </div>

        <div className="relative z-10 mt-4">
          {activeTab === "departments" ? (
            <div className="grid gap-4 lg:grid-cols-[0.76fr_1.24fr]">
              <DepartmentTable
                selectedDepartment={selectedDepartment}
                onSelect={(name) =>
                  setSelectedDepartment((prev) =>
                    prev === name ? null : name
                  )
                }
              />
              <PowerUsersTable
                rows={
                  selectedDepartment
                    ? powerUsers.filter(
                        (u) => u.department === selectedDepartment
                      )
                    : powerUsers
                }
                selectedDepartment={selectedDepartment}
                onClearDepartmentFilter={() => setSelectedDepartment(null)}
              />
            </div>
          ) : (
            <ToolsTable
              rows={visibleTools}
              selectedTool={selectedTool}
              onSelect={(name) =>
                setSelectedTool((prev) => (prev === name ? null : name))
              }
              selectedDepartment={selectedDepartment}
              onClearDepartmentFilter={() => setSelectedDepartment(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MacChrome() {
  return (
    <div className="flex h-9 items-center gap-2 bg-[#f6f6f4] px-4 md:h-11 md:gap-3 md:px-5">
      <div className="h-3 w-3 rounded-full bg-[#FF5F57]" />
      <div className="h-3 w-3 rounded-full bg-[#FEBC2E]" />
      <div className="h-3 w-3 rounded-full bg-[#28C840]" />
    </div>
  );
}

function TopNav() {
  return (
    <div className="relative z-10 flex items-center justify-between border-b border-[#e7e9f0] pb-4">
      <div className="flex items-center gap-2.5 md:gap-3">
        <OpenWorkMark className="h-[26px] w-[33px] md:h-[28px] md:w-[36px]" />
        <span className="text-[16px] font-semibold tracking-[-0.02em] text-[#011627] md:text-[18px]">
          OpenWork
        </span>
      </div>

      <div className="flex items-center gap-4 text-[#30405F] md:gap-5">
        <Search className="h-5 w-5 stroke-[1.8]" aria-hidden="true" />
        <Bell className="h-5 w-5 stroke-[1.8]" aria-hidden="true" />
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#EEF2FB] text-[13px] font-medium text-[#30405F] md:h-9 md:w-9 md:text-[14px]">
          AG
        </div>
      </div>
    </div>
  );
}

type StatCardProps = {
  icon: React.ReactNode;
  title: string;
  value: string;
  subvalue?: string;
  tone: "violet" | "green" | "blue";
};

function StatCard({ icon, title, value, subvalue, tone }: StatCardProps) {
  return (
    <div className="rounded-[18px] border border-[#e3e7ee] bg-white/90 px-4 py-4 shadow-[0_1px_0_rgba(7,25,44,0.02)] md:rounded-[20px] md:px-5 md:py-5">
      <div className="flex items-center gap-3 md:gap-4">
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] md:h-14 md:w-14 md:rounded-[14px] ${toneBg(tone)}`}
        >
          {icon}
        </div>

        <div className="min-w-0">
          <div className="text-[13px] font-medium tracking-[-0.01em] text-[#30405F] md:text-[14px]">
            {title}
          </div>
          <div className="mt-1 text-[20px] font-semibold tracking-[-0.03em] text-[#07192C] md:text-[24px]">
            {value}
          </div>
          {subvalue ? (
            <div className="mt-0.5 truncate text-[12px] text-[#637291] md:text-[13px]">
              {subvalue}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type TabBarProps = {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
};

function TabBar({ activeTab, onChange }: TabBarProps) {
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "departments", label: "Department view" },
    { id: "tools", label: "Most used AI tools" }
  ];

  return (
    <div
      role="tablist"
      aria-label="Enterprise dashboard views"
      className="inline-flex items-center gap-1 rounded-full border border-[#e3e7ee] bg-white/80 p-1 shadow-[0_1px_0_rgba(7,25,44,0.02)]"
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`enterprise-tab-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors md:text-[13px] ${
              selected
                ? "bg-[#07192C] text-white"
                : "text-[#30405F] hover:text-[#07192C]"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

type DepartmentTableProps = {
  selectedDepartment: string | null;
  onSelect: (name: string) => void;
};

function DepartmentTable({
  selectedDepartment,
  onSelect
}: DepartmentTableProps) {
  const grouped = departments.reduce<Record<DepartmentCategory, Department[]>>(
    (acc, row) => {
      acc[row.category].push(row);
      return acc;
    },
    {
      "Technical teams": [],
      "Business teams": []
    }
  );

  return (
    <div
      id="enterprise-tab-departments"
      role="tabpanel"
      aria-label="Top AI adoption departments"
      className="overflow-hidden rounded-[18px] border border-[#e3e7ee] bg-white/90 shadow-[0_1px_0_rgba(7,25,44,0.02)] md:rounded-[20px]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[#e9edf3] px-4 py-3 md:px-5 md:py-4">
        <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-[#07192C] md:text-[16px]">
          Top AI adoption departments
        </h3>
      </div>

      <div className="grid grid-cols-[1.1fr_0.9fr_0.55fr_0.7fr_0.9fr] gap-3 border-b border-[#e9edf3] px-4 py-3 text-[11px] font-medium text-[#5A6886] md:px-5 md:text-[12.5px]">
        <div>Team</div>
        <div>Daily active</div>
        <div>Spend</div>
        <div>Avg / person</div>
        <div>Power users</div>
      </div>

      {(["Technical teams", "Business teams"] as const).map((group) => (
        <div key={group}>
          <div className="border-b border-[#eef1f5] bg-white/60 px-4 py-2 text-[11px] font-medium text-[#5A6886] md:px-5 md:text-[12.5px]">
            {group}
          </div>

          {grouped[group].map((row) => {
            const isSelected = selectedDepartment === row.name;
            return (
              <button
                key={row.name}
                type="button"
                onClick={() => onSelect(row.name)}
                aria-pressed={isSelected}
                className={`grid w-full grid-cols-[1.1fr_0.9fr_0.55fr_0.7fr_0.9fr] items-center gap-3 border-b border-[#eef1f5] px-4 py-3 text-left transition-colors last:border-b-0 md:px-5 md:py-3.5 ${
                  isSelected
                    ? "bg-[#F4F1FF]"
                    : "hover:bg-[#F7F8FC] focus-visible:bg-[#F7F8FC]"
                }`}
              >
                <div className="text-[13px] font-medium tracking-[-0.01em] text-[#07192C] md:text-[14px]">
                  {row.name}
                </div>
                <div className="text-[13px] text-[#30405F] md:text-[14px]">
                  {row.dailyActive}
                </div>
                <div className="text-[13px] text-[#30405F] md:text-[14px]">
                  {row.spend}
                </div>
                <div className="text-[13px] text-[#30405F] md:text-[14px]">
                  {row.avgPerPerson}
                </div>
                <div className="flex items-center gap-1.5">
                  {row.powerUsers.map((user) =>
                    user.startsWith("+") ? (
                      <span
                        key={user}
                        className="text-[12px] text-[#5A6886] md:text-[13px]"
                      >
                        {user}
                      </span>
                    ) : (
                      <InitialPill
                        key={user}
                        department={row.name}
                        initials={user}
                      />
                    )
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

type PowerUsersTableProps = {
  rows: PowerUser[];
  selectedDepartment: string | null;
  onClearDepartmentFilter: () => void;
};

function PowerUsersTable({
  rows,
  selectedDepartment,
  onClearDepartmentFilter
}: PowerUsersTableProps) {
  return (
    <div className="overflow-hidden rounded-[18px] border border-[#e3e7ee] bg-white/90 shadow-[0_1px_0_rgba(7,25,44,0.02)] md:rounded-[20px]">
      <div className="flex items-center justify-between gap-3 border-b border-[#e9edf3] px-4 py-3 md:px-5 md:py-4">
        <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-[#07192C] md:text-[16px]">
          Power users
        </h3>
        {selectedDepartment ? (
          <button
            type="button"
            onClick={onClearDepartmentFilter}
            className="inline-flex items-center gap-1 rounded-full border border-[#e3e7ee] bg-[#F4F1FF] px-2.5 py-0.5 text-[11px] font-medium text-[#6F3DFF] transition-colors hover:bg-[#EDE4FF] md:text-[12px]"
          >
            {selectedDepartment} · clear
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-[1.75fr_1.1fr_0.8fr_0.55fr_0.75fr_0.75fr_0.65fr] gap-2 border-b border-[#e9edf3] px-4 py-3 text-[11px] font-medium text-[#5A6886] md:px-5 md:text-[12px]">
        <div>Name</div>
        <div>Top tool</div>
        <div>Trend</div>
        <div className="text-right">Requests</div>
        <div className="text-right">In tokens</div>
        <div className="text-right">Out tokens</div>
        <div className="text-right">Cost</div>
      </div>

      {rows.map((user) => (
        <div
          key={user.name}
          className="grid grid-cols-[1.75fr_1.1fr_0.8fr_0.55fr_0.75fr_0.75fr_0.65fr] items-center gap-2 border-b border-[#eef1f5] px-4 py-3 text-left last:border-b-0 md:px-5 md:py-3.5"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <InitialPill
              department={user.department}
              initials={user.initials}
            />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium tracking-[-0.01em] text-[#07192C] md:text-[14px]">
                {user.name}
              </div>
              <div className="truncate text-[11px] text-[#637291] md:text-[12px]">
                {user.department}
              </div>
            </div>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <ToolGlyph tool={user.topTool} small />
            <span className="truncate text-[12px] font-medium tracking-[-0.01em] text-[#07192C] md:text-[13px]">
              {user.topTool}
            </span>
          </div>

          <div>
            <Sparkline
              values={user.trend}
              color={sparklineColor(user.department)}
            />
          </div>

          <div className="text-right text-[12px] tabular-nums text-[#30405F] md:text-[13px]">
            {user.requests}
          </div>
          <div className="text-right text-[12px] tabular-nums text-[#30405F] md:text-[13px]">
            {user.inputTokens}
          </div>
          <div className="text-right text-[12px] tabular-nums text-[#30405F] md:text-[13px]">
            {user.outputTokens}
          </div>
          <div className="text-right text-[12px] font-medium tabular-nums text-[#07192C] md:text-[13px]">
            {user.cost}
          </div>
        </div>
      ))}

      {rows.length === 0 ? (
        <div className="px-5 py-6 text-center text-[12px] text-[#637291] md:text-[13px]">
          No power users in {selectedDepartment}. {" "}
          <button
            type="button"
            onClick={onClearDepartmentFilter}
            className="font-medium text-[#6F3DFF] underline-offset-2 hover:underline"
          >
            Clear filter
          </button>
          .
        </div>
      ) : null}
    </div>
  );
}

type ToolsTableProps = {
  rows: ToolRow[];
  selectedTool: string | null;
  onSelect: (name: string) => void;
  selectedDepartment: string | null;
  onClearDepartmentFilter: () => void;
};

function ToolsTable({
  rows,
  selectedTool,
  onSelect,
  selectedDepartment,
  onClearDepartmentFilter
}: ToolsTableProps) {
  return (
    <div
      id="enterprise-tab-tools"
      role="tabpanel"
      aria-label="Most used AI tools"
      className="overflow-hidden rounded-[18px] border border-[#e3e7ee] bg-white/90 shadow-[0_1px_0_rgba(7,25,44,0.02)] md:rounded-[20px]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[#e9edf3] px-4 py-3 md:px-5 md:py-4">
        <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-[#07192C] md:text-[16px]">
          Most used AI tools
        </h3>
        {selectedDepartment ? (
          <button
            type="button"
            onClick={onClearDepartmentFilter}
            className="inline-flex items-center gap-1 rounded-full border border-[#e3e7ee] bg-[#F4F1FF] px-2.5 py-0.5 text-[11px] font-medium text-[#6F3DFF] transition-colors hover:bg-[#EDE4FF] md:text-[12px]"
          >
            {selectedDepartment} · clear
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-[1.4fr_0.7fr_0.8fr_1.5fr_1.8fr] gap-3 border-b border-[#e9edf3] px-4 py-3 text-[11px] font-medium text-[#5A6886] md:px-5 md:text-[12.5px]">
        <div>Tool</div>
        <div>Penetration</div>
        <div>Daily active users</div>
        <div>Top departments</div>
        <div>Common models</div>
      </div>

      {rows.map((row) => {
        const isSelected = selectedTool === row.tool;
        return (
          <button
            key={row.tool}
            type="button"
            onClick={() => onSelect(row.tool)}
            aria-pressed={isSelected}
            className={`grid w-full grid-cols-[1.4fr_0.7fr_0.8fr_1.5fr_1.8fr] items-center gap-3 border-b border-[#eef1f5] px-4 py-3 text-left transition-colors last:border-b-0 md:px-5 md:py-4 ${
              isSelected
                ? "bg-[#EEF3FF]"
                : "hover:bg-[#F7F8FC] focus-visible:bg-[#F7F8FC]"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <ToolGlyph tool={row.tool} />
              <span className="truncate text-[13px] font-medium tracking-[-0.01em] text-[#07192C] md:text-[14px]">
                {row.tool}
              </span>
            </div>
            <div className="text-[13px] text-[#30405F] md:text-[14px]">
              {row.penetration}
            </div>
            <div className="text-[13px] text-[#30405F] md:text-[14px]">
              {row.dailyActiveUsers}
            </div>
            <div className="text-[12px] leading-5 text-[#30405F] md:text-[13px] md:leading-6">
              {row.topDepartments}
            </div>
            <div className="text-[12px] leading-5 text-[#30405F] md:text-[13px] md:leading-6">
              {row.commonModels}
            </div>
          </button>
        );
      })}

      {rows.length === 0 ? (
        <div className="px-5 py-6 text-center text-[12px] text-[#637291] md:text-[13px]">
          No tools match {selectedDepartment}. {" "}
          <button
            type="button"
            onClick={onClearDepartmentFilter}
            className="font-medium text-[#6F3DFF] underline-offset-2 hover:underline"
          >
            Clear filter
          </button>
          .
        </div>
      ) : null}
    </div>
  );
}

type SparklineProps = {
  values: number[];
  color: string;
};

function Sparkline({ values, color }: SparklineProps) {
  const width = 72;
  const height = 22;
  const padding = 2;

  if (values.length === 0) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const stepX = (width - padding * 2) / Math.max(values.length - 1, 1);

  const points = values.map((v, i) => {
    const x = padding + i * stepX;
    const y =
      padding + (height - padding * 2) * (1 - (v - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const areaPath =
    `M ${padding},${height - padding} ` +
    points.map((p) => `L ${p}`).join(" ") +
    ` L ${width - padding},${height - padding} Z`;

  const linePath = `M ${points.join(" L ")}`;

  const last = points[points.length - 1].split(",");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`Trend ${values[0]} to ${values[values.length - 1]}`}
      className="block"
    >
      <path d={areaPath} fill={color} fillOpacity="0.12" />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="1.6" fill={color} />
    </svg>
  );
}

function ToolGlyph({ tool, small = false }: { tool: string; small?: boolean }) {
  const sizeClass = small
    ? "h-6 w-6 rounded-[7px]"
    : "h-7 w-7 rounded-[8px] md:h-8 md:w-8 md:rounded-[9px]";

  if (tool === "OpenWork") {
    return (
      <div
        className={`flex shrink-0 items-center justify-center border border-[#d9ddeb] bg-[#fbfbfa] p-0.5 text-[#011627] ${sizeClass}`}
      >
        <OpenWorkMark
          className={small ? "h-3.5 w-[18px]" : "h-4 w-5 md:h-[18px] md:w-[22px]"}
        />
      </div>
    );
  }

  const iconMap: Record<string, React.ReactNode> = {
    Cursor: (
      <span className={small ? "text-[11px] font-semibold" : "text-[12px] font-semibold md:text-[13px]"}>
        C
      </span>
    ),
    "Figma AI": (
      <span className={small ? "text-[11px] font-semibold" : "text-[12px] font-semibold md:text-[13px]"}>
        F
      </span>
    ),
    "Notion AI": (
      <span className={small ? "text-[11px] font-semibold" : "text-[12px] font-semibold md:text-[13px]"}>
        N
      </span>
    ),
    "Zendesk AI": (
      <span className={small ? "text-[11px] font-semibold" : "text-[12px] font-semibold md:text-[13px]"}>
        Z
      </span>
    )
  };

  return (
    <div
      className={`flex shrink-0 items-center justify-center border border-[#d9ddeb] bg-[#f7f8fb] text-[#30405F] ${sizeClass}`}
    >
      {iconMap[tool] ?? (
        <Brain className={small ? "h-3 w-3" : "h-3.5 w-3.5 md:h-4 md:w-4"} />
      )}
    </div>
  );
}

function InitialPill({
  initials,
  department
}: {
  initials: string;
  department: string;
}) {
  return (
    <div
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tracking-[-0.02em] md:h-8 md:w-8 md:text-[12px] ${departmentColor(
        department
      )}`}
    >
      {initials}
    </div>
  );
}

function departmentColor(department: string) {
  switch (department) {
    case "Engineering":
      return "bg-[#F9DADB] text-[#B43035]";
    case "Data Science":
      return "bg-[#E7DEFF] text-[#6F3DFF]";
    case "Product":
      return "bg-[#DFEAFE] text-[#1D63FF]";
    case "Customer Support":
      return "bg-[#DFF5F6] text-[#127B85]";
    case "Marketing":
      return "bg-[#FBE6D7] text-[#E56A17]";
    case "Sales":
      return "bg-[#E3F4DF] text-[#2C8B39]";
    case "Legal":
      return "bg-[#E8EBEF] text-[#5A6886]";
    default:
      return "bg-[#EEF2F7] text-[#30405F]";
  }
}

function sparklineColor(department: string) {
  switch (department) {
    case "Engineering":
      return "#B43035";
    case "Data Science":
      return "#6F3DFF";
    case "Product":
      return "#1D63FF";
    case "Customer Support":
      return "#127B85";
    case "Marketing":
      return "#E56A17";
    case "Sales":
      return "#2C8B39";
    case "Legal":
      return "#5A6886";
    default:
      return "#30405F";
  }
}

function toneBg(tone: "violet" | "green" | "blue") {
  switch (tone) {
    case "violet":
      return "bg-[#EDE4FF]";
    case "green":
      return "bg-[#E3F3E3]";
    case "blue":
      return "bg-[#E4ECFB]";
  }
}

export default LandingEnterpriseHero;
