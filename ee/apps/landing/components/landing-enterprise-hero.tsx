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
import { useState } from "react";
import { OpenWorkMark } from "./openwork-mark";

type Department = {
  name: string;
  dailyActive: string;
  spend: string;
  avgPerPerson: string;
  /** Daily active users over the last 10 weekdays. */
  trend: number[];
  powerUsers: string[];
};

type ToolRow = {
  tool: string;
  penetration: string;
  topDepartment: string;
  topUsers: string[];
  featured?: boolean;
};

type PowerUser = {
  name: string;
  initials: string;
  department: string;
  topTool: string;
  /** Cumulative requests by weekday (10 weekdays). Shape reveals usage personality. */
  trend: number[];
  /** One-line descriptor of the usage personality (shown as tooltip). */
  trendNote: string;
  requests: string;
  inputTokens: string;
  outputTokens: string;
  cost: string;
};

const departments: Department[] = [
  {
    name: "Engineering",
    dailyActive: "48 / 82",
    spend: "$330K",
    avgPerPerson: "$4.1K",
    trend: [42, 44, 43, 45, 46, 46, 47, 47, 48, 48],
    powerUsers: ["JC", "LT", "AL", "+5"]
  },
  {
    name: "Product",
    dailyActive: "9 / 24",
    spend: "$90K",
    avgPerPerson: "$3.8K",
    trend: [4, 5, 5, 4, 6, 7, 6, 8, 8, 9],
    powerUsers: ["HL", "DG", "AR", "+1"]
  },
  {
    name: "Customer Support",
    dailyActive: "7 / 36",
    spend: "$30K",
    avgPerPerson: "$968",
    trend: [3, 4, 4, 5, 5, 6, 6, 7, 7, 7],
    powerUsers: ["MF", "SG", "RM", "+2"]
  },
  {
    name: "Marketing",
    dailyActive: "3 / 28",
    spend: "$18K",
    avgPerPerson: "$643",
    trend: [1, 1, 1, 2, 1, 2, 2, 3, 3, 3],
    powerUsers: ["RF", "AS", "JR", "+1"]
  },
  {
    name: "Sales",
    dailyActive: "1 / 25",
    spend: "$15K",
    avgPerPerson: "$600",
    trend: [0, 1, 0, 0, 0, 1, 1, 0, 1, 1],
    powerUsers: ["AC", "WB", "HF", "+2"]
  },
  {
    name: "Legal",
    dailyActive: "0 / 12",
    spend: "$7K",
    avgPerPerson: "$583",
    trend: [3, 2, 2, 1, 1, 1, 0, 0, 0, 0],
    powerUsers: ["SD", "OB", "RH", "+1"]
  }
];

const toolRows: ToolRow[] = [
  {
    tool: "OpenWork",
    penetration: "41%",
    topDepartment: "Customer Support",
    topUsers: ["AL", "AC", "WB"],
    featured: true
  },
  {
    tool: "Cursor",
    penetration: "24%",
    topDepartment: "Engineering",
    topUsers: ["JC", "LT", "AT"]
  },
  {
    tool: "Figma AI",
    penetration: "11%",
    topDepartment: "Product",
    topUsers: ["HL", "RF"]
  },
  {
    tool: "Notion AI",
    penetration: "9%",
    topDepartment: "Product",
    topUsers: ["DG", "AS"]
  },
  {
    tool: "Zendesk AI",
    penetration: "7%",
    topDepartment: "Customer Support",
    topUsers: ["MF", "SG"]
  }
];

const powerUsers: PowerUser[] = [
  {
    name: "John Carmack",
    initials: "JC",
    department: "Engineering",
    topTool: "Zed",
    trend: [60, 200, 290, 490, 610, 780, 860, 1080, 1260, 1400],
    trendNote: "Deep-work bursts, quiet days in between",
    requests: "1.4K",
    inputTokens: "820K",
    outputTokens: "310K",
    cost: "$1.2K"
  },
  {
    name: "Linus Torvalds",
    initials: "LT",
    department: "Engineering",
    topTool: "Omarchy",
    trend: [105, 217, 325, 440, 550, 658, 771, 881, 993, 1100],
    trendNote: "Steady daily rhythm, every weekday the same",
    requests: "1.1K",
    inputTokens: "640K",
    outputTokens: "250K",
    cost: "$910"
  },
  {
    name: "Ada Lovelace",
    initials: "AL",
    department: "Engineering",
    topTool: "Hugging Face",
    trend: [160, 300, 420, 530, 630, 720, 800, 860, 920, 960],
    trendNote: "Early-adopter curve — curiosity cooling off",
    requests: "960",
    inputTokens: "540K",
    outputTokens: "210K",
    cost: "$780"
  },
  {
    name: "Alan Turing",
    initials: "AT",
    department: "Engineering",
    topTool: "Claude Code",
    trend: [88, 176, 264, 352, 440, 528, 616, 704, 792, 880],
    trendNote: "Scheduled automation — same batch every day",
    requests: "880",
    inputTokens: "500K",
    outputTokens: "200K",
    cost: "$690"
  },
  {
    name: "Marie Curie",
    initials: "MC",
    department: "Engineering",
    topTool: "OpenWork",
    trend: [30, 70, 120, 180, 250, 330, 420, 520, 615, 680],
    trendNote: "Learning curve — compounding every week",
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
    trend: [15, 35, 60, 90, 130, 190, 265, 345, 430, 510],
    trendNote: "Late adopter — just caught the wave",
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
    trend: [40, 82, 125, 168, 210, 253, 297, 341, 386, 430],
    trendNote: "Patient, near-identical daily habit",
    requests: "430",
    inputTokens: "240K",
    outputTokens: "115K",
    cost: "$360"
  }
];

const peopleByInitials: Record<
  string,
  { name?: string; department: string }
> = {
  JC: { name: "John Carmack", department: "Engineering" },
  LT: { name: "Linus Torvalds", department: "Engineering" },
  AL: { name: "Ada Lovelace", department: "Engineering" },
  MC: { name: "Marie Curie", department: "Engineering" },
  AT: { name: "Alan Turing", department: "Engineering" },
  AC: { name: "Andrew Carnegie", department: "Sales" },
  WB: { name: "Warren Buffett", department: "Sales" },
  HF: { name: "Henry Ford", department: "Sales" },
  HL: { department: "Product" },
  DG: { department: "Product" },
  AR: { department: "Product" },
  MF: { department: "Customer Support" },
  SG: { department: "Customer Support" },
  RM: { department: "Customer Support" },
  RF: { department: "Marketing" },
  AS: { department: "Marketing" },
  JR: { department: "Marketing" },
  SD: { department: "Legal" },
  OB: { department: "Legal" },
  RH: { department: "Legal" }
};

type TabId = "departments" | "users" | "tools";

type Props = {
  /** When true, the outer card renders its own rounded border + shadow. When false, the caller wraps it. */
  standalone?: boolean;
};

export function LandingEnterpriseHero({ standalone = false }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("departments");

  const shell = standalone
    ? "overflow-hidden rounded-[28px] border border-[#dde2ea] bg-[#fbfbfa] shadow-[0_18px_60px_rgba(7,25,44,0.08)]"
    : "overflow-hidden bg-[#fbfbfa]";

  const tabCopy: Record<TabId, { crumb: string; description: string }> = {
    departments: {
      crumb: "Departments",
      description:
        "Where AI usage is concentrated across the org, by team."
    },
    users: {
      crumb: "Power users",
      description:
        "The individuals driving the most AI usage. Use them to teach the rest of the org."
    },
    tools: {
      crumb: "AI tools",
      description:
        "The tools people reach for, who uses them most, and who to ask for access."
    }
  };

  return (
    <div className={shell}>
      <MacChrome />

      <div className="relative border-t border-[#e7e9f0] px-4 pb-5 pt-3 sm:px-6 md:px-8 md:pb-6 md:pt-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[180px] bg-[radial-gradient(circle_at_88%_20%,rgba(122,92,255,0.1),transparent_26%),radial-gradient(circle_at_98%_28%,rgba(255,143,71,0.06),transparent_16%)]" />

        <HeaderBar crumb={tabCopy[activeTab].crumb} />

        <p className="relative z-10 mt-2 text-[13px] leading-6 text-[#5A6886] md:text-[14px] md:leading-6">
          {tabCopy[activeTab].description}
        </p>

        <div className="relative z-10 mt-4 grid gap-3 md:grid-cols-3 md:gap-3.5">
          <StatCard
            icon={<Users className="h-5 w-5 text-[#6F3DFF]" />}
            title="Daily active AI users"
            value="68 / 131"
            tone="violet"
          />
          <StatCard
            icon={<DollarSign className="h-5 w-5 text-[#18A34A]" />}
            title="Monthly spend"
            value="$480K"
            tone="green"
          />
          <StatCard
            icon={<Gauge className="h-5 w-5 text-[#1D63FF]" />}
            title="Top-tool penetration"
            value="41%"
            subvalue="OpenWork · 54 users"
            tone="blue"
          />
        </div>

        <div className="relative z-10 mt-4">
          <TabBar activeTab={activeTab} onChange={setActiveTab} />
        </div>

        <div className="relative z-10 mt-3">
          {activeTab === "departments" ? <DepartmentsTable /> : null}
          {activeTab === "users" ? <PowerUsersTable /> : null}
          {activeTab === "tools" ? <ToolsTable /> : null}
        </div>
      </div>
    </div>
  );
}

function MacChrome() {
  return (
    <div className="flex h-8 items-center gap-1.5 bg-[#f6f6f4] px-3 md:h-10 md:gap-2 md:px-4">
      <div className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
      <div className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]" />
      <div className="h-2.5 w-2.5 rounded-full bg-[#28C840]" />
    </div>
  );
}

function HeaderBar({ crumb }: { crumb: string }) {
  return (
    <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-[#e7e9f0] pb-3">
      <div className="flex flex-wrap items-center gap-2.5 md:gap-3">
        <OpenWorkMark className="h-[24px] w-[30px] md:h-[26px] md:w-[33px]" />
        <span className="inline-flex items-center rounded-[8px] bg-[#F8E8D7] px-2.5 py-0.5 text-[11px] font-semibold text-[#E56A17] md:text-[12px]">
          Q2
        </span>
        <span className="text-[13px] font-medium tracking-[-0.01em] text-[#5A6886] md:text-[14px]">
          AI Adoption
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-[#9AA5BA]" />
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-[#07192C] md:text-[14px]">
          {crumb}
        </span>
      </div>

      <div className="flex items-center gap-3 text-[#30405F] md:gap-4">
        <button
          type="button"
          title="Search"
          aria-label="Search"
          className="rounded-full p-1 transition-colors hover:bg-[#EEF2FB]"
        >
          <Search className="h-[18px] w-[18px] stroke-[1.8] md:h-5 md:w-5" aria-hidden="true" />
        </button>
        <button
          type="button"
          title="Notifications"
          aria-label="Notifications"
          className="rounded-full p-1 transition-colors hover:bg-[#EEF2FB]"
        >
          <Bell className="h-[18px] w-[18px] stroke-[1.8] md:h-5 md:w-5" aria-hidden="true" />
        </button>
        <div
          title="Alex Garcia · Admin"
          className="flex h-7 w-7 cursor-default items-center justify-center rounded-full bg-[#EEF2FB] text-[12px] font-medium text-[#30405F] md:h-8 md:w-8 md:text-[13px]"
        >
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
    <div className="rounded-[14px] border border-[#e3e7ee] bg-white/90 px-3.5 py-3 md:rounded-[16px] md:px-4 md:py-3.5">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] md:h-11 md:w-11 md:rounded-[12px] ${toneBg(tone)}`}
        >
          {icon}
        </div>

        <div className="min-w-0">
          <div className="text-[12px] font-medium tracking-[-0.01em] text-[#30405F] md:text-[13px]">
            {title}
          </div>
          <div className="mt-0.5 text-[18px] font-semibold tracking-[-0.03em] text-[#07192C] md:text-[20px]">
            {value}
          </div>
          {subvalue ? (
            <div className="mt-0.5 truncate text-[11px] text-[#637291] md:text-[12px]">
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
    { id: "departments", label: "Departments" },
    { id: "users", label: "Power users" },
    { id: "tools", label: "AI tools" }
  ];

  return (
    <div
      role="tablist"
      aria-label="Enterprise AI leaderboard"
      className="inline-flex items-center gap-1 rounded-full border border-[#e3e7ee] bg-white/80 p-1"
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors md:text-[13px] ${
              selected
                ? "bg-[#07192C] text-white"
                : "text-[#30405F] hover:bg-[#F4F6FB] hover:text-[#07192C]"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function DepartmentsTable() {
  return (
    <div
      role="tabpanel"
      aria-label="Departments leaderboard"
      className="overflow-hidden rounded-[14px] border border-[#e3e7ee] bg-white/90 md:rounded-[16px]"
    >
      <div className="grid grid-cols-[1.2fr_0.65fr_0.55fr_0.65fr_0.85fr_1.1fr] gap-3 border-b border-[#e9edf3] px-4 py-2.5 text-[11px] font-medium text-[#5A6886] md:px-5 md:py-3 md:text-[12px]">
        <div>Team</div>
        <div>Daily active</div>
        <div>Spend</div>
        <div>Avg / person</div>
        <div>Adoption trend</div>
        <div>Power users</div>
      </div>

      {departments.map((row) => (
        <div
          key={row.name}
          className="grid grid-cols-[1.2fr_0.65fr_0.55fr_0.65fr_0.85fr_1.1fr] items-center gap-3 border-b border-[#eef1f5] px-4 py-2.5 transition-colors last:border-b-0 hover:bg-[#F6F8FC] md:px-5 md:py-3"
        >
          <div className="text-[13px] font-medium tracking-[-0.01em] text-[#07192C] md:text-[14px]">
            {row.name}
          </div>
          <div className="text-[12px] tabular-nums text-[#30405F] md:text-[13px]">
            {row.dailyActive}
          </div>
          <div className="text-[12px] tabular-nums text-[#30405F] md:text-[13px]">
            {row.spend}
          </div>
          <div className="text-[12px] tabular-nums text-[#30405F] md:text-[13px]">
            {row.avgPerPerson}
          </div>
          <div>
            <Sparkline
              values={row.trend}
              color={trendDirectionColor(row.trend)}
              title={`${row.name} adoption: ${row.trend[0]} \u2192 ${row.trend[row.trend.length - 1]} daily active users`}
            />
          </div>
          <div className="flex items-center gap-1">
            {row.powerUsers.map((user) =>
              user.startsWith("+") ? (
                <span
                  key={user}
                  className="text-[11px] text-[#5A6886] md:text-[12px]"
                  title={`${user.replace("+", "")} more in ${row.name}`}
                >
                  {user}
                </span>
              ) : (
                <InitialPill
                  key={user}
                  department={peopleByInitials[user]?.department ?? row.name}
                  initials={user}
                  name={peopleByInitials[user]?.name}
                />
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PowerUsersTable() {
  return (
    <div
      role="tabpanel"
      aria-label="Power users leaderboard"
      className="overflow-hidden rounded-[14px] border border-[#e3e7ee] bg-white/90 md:rounded-[16px]"
    >
      <div className="grid grid-cols-[1.6fr_1fr_0.85fr_0.55fr_0.7fr_0.7fr_0.6fr] gap-2 border-b border-[#e9edf3] px-4 py-2.5 text-[11px] font-medium text-[#5A6886] md:px-5 md:py-3 md:text-[12px]">
        <div>Name</div>
        <div>Top tool</div>
        <div>Cumulative trend</div>
        <div className="text-right">Requests</div>
        <div className="text-right">In tokens</div>
        <div className="text-right">Out tokens</div>
        <div className="text-right">Cost</div>
      </div>

      {powerUsers.map((user) => (
        <div
          key={user.name}
          className="grid grid-cols-[1.6fr_1fr_0.85fr_0.55fr_0.7fr_0.7fr_0.6fr] items-center gap-2 border-b border-[#eef1f5] px-4 py-2.5 transition-colors last:border-b-0 hover:bg-[#F6F8FC] md:px-5 md:py-3"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <InitialPill
              department={user.department}
              initials={user.initials}
              name={user.name}
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
              title={`${user.trendNote} — cumulative ${user.trend[0].toLocaleString()} \u2192 ${user.trend[user.trend.length - 1].toLocaleString()} over 10 weekdays`}
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
    </div>
  );
}

function ToolsTable() {
  return (
    <div
      role="tabpanel"
      aria-label="AI tools leaderboard"
      className="overflow-hidden rounded-[14px] border border-[#e3e7ee] bg-white/90 md:rounded-[16px]"
    >
      <div className="grid grid-cols-[1.4fr_0.7fr_1.2fr_1fr] gap-3 border-b border-[#e9edf3] px-4 py-2.5 text-[11px] font-medium text-[#5A6886] md:px-5 md:py-3 md:text-[12px]">
        <div>Tool</div>
        <div>Penetration</div>
        <div>Top department</div>
        <div>Power users</div>
      </div>

      {toolRows.map((row) => (
        <div
          key={row.tool}
          className={`grid grid-cols-[1.4fr_0.7fr_1.2fr_1fr] items-center gap-3 border-b border-[#eef1f5] px-4 py-3 transition-colors last:border-b-0 md:px-5 md:py-3.5 ${
            row.featured
              ? "bg-[#EEF3FF] hover:bg-[#E3EBFE]"
              : "hover:bg-[#F6F8FC]"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <ToolGlyph tool={row.tool} />
            <span className="truncate text-[13px] font-medium tracking-[-0.01em] text-[#07192C] md:text-[14px]">
              {row.tool}
            </span>
          </div>
          <div className="text-[13px] tabular-nums text-[#30405F] md:text-[14px]">
            {row.penetration}
          </div>
          <div className="text-[13px] text-[#30405F] md:text-[14px]">
            {row.topDepartment}
          </div>
          <div className="flex items-center gap-1.5">
            {row.topUsers.map((initials) => {
              const person = peopleByInitials[initials];
              return (
                <InitialPill
                  key={initials}
                  department={person?.department ?? row.topDepartment}
                  initials={initials}
                  name={person?.name}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

type SparklineProps = {
  values: number[];
  color: string;
  title?: string;
};

function Sparkline({ values, color, title }: SparklineProps) {
  const width = 80;
  const height = 20;
  const padding = 2;

  if (values.length === 0) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const stepX = (width - padding * 2) / Math.max(values.length - 1, 1);

  const points = values.map((v, i) => {
    const x = padding + i * stepX;
    const y = padding + (height - padding * 2) * (1 - (v - min) / range);
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
      aria-label={title ?? `Trend ${values[0]} to ${values[values.length - 1]}`}
      className="block"
    >
      {title ? <title>{title}</title> : null}
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
    ? "h-5 w-5 rounded-[6px]"
    : "h-6 w-6 rounded-[7px] md:h-7 md:w-7 md:rounded-[8px]";

  if (tool === "OpenWork") {
    return (
      <div
        title={tool}
        className={`flex shrink-0 items-center justify-center border border-[#d9ddeb] bg-[#fbfbfa] p-0.5 text-[#011627] ${sizeClass}`}
      >
        <OpenWorkMark
          className={small ? "h-3 w-4" : "h-3.5 w-4 md:h-4 md:w-[18px]"}
        />
      </div>
    );
  }

  const textSizeClass = small
    ? "text-[10px] font-semibold"
    : "text-[11px] font-semibold md:text-[12px]";

  const iconMap: Record<string, React.ReactNode> = {
    Cursor: <span className={textSizeClass}>C</span>,
    "Figma AI": <span className={textSizeClass}>F</span>,
    "Notion AI": <span className={textSizeClass}>N</span>,
    "Zendesk AI": <span className={textSizeClass}>Z</span>,
    Zed: <span className={textSizeClass}>Z</span>,
    Omarchy: <span className={textSizeClass}>O</span>,
    "Hugging Face": <span className={small ? "text-[11px]" : "text-[13px] md:text-[14px]"}>🤗</span>,
    "Claude Code": <span className={textSizeClass}>CC</span>
  };

  return (
    <div
      title={tool}
      className={`flex shrink-0 items-center justify-center border border-[#d9ddeb] bg-[#f7f8fb] text-[#30405F] ${sizeClass}`}
    >
      {iconMap[tool] ?? (
        <Brain className={small ? "h-3 w-3" : "h-3.5 w-3.5"} />
      )}
    </div>
  );
}

function InitialPill({
  initials,
  department,
  name
}: {
  initials: string;
  department: string;
  name?: string;
}) {
  const tooltip = name
    ? `${name} · ${department}`
    : `${initials} · ${department}`;

  return (
    <div
      title={tooltip}
      aria-label={tooltip}
      className={`flex h-6 w-6 shrink-0 cursor-default items-center justify-center rounded-full text-[10px] font-semibold tracking-[-0.02em] md:h-7 md:w-7 md:text-[11px] ${departmentColor(
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

/**
 * Color the adoption trend line by direction so users can scan up/down/flat at a glance.
 * Uses 3-point rolling averages at each end to avoid false signals on a single spiky day.
 */
function trendDirectionColor(trend: number[]): string {
  if (trend.length < 3) return "#637291";
  const startAvg = (trend[0] + trend[1] + trend[2]) / 3;
  const endAvg = trend.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const delta = endAvg - startAvg;
  if (delta > 0.5) return "#18A34A"; // green
  if (delta < -0.5) return "#B43035"; // red
  return "#637291"; // gray
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
