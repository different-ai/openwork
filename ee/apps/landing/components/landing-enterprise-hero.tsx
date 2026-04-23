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

const departments: Department[] = [
  {
    name: "Engineering",
    category: "Technical teams",
    dailyActive: "32 / 54",
    spend: "$210K",
    avgPerPerson: "$4.4K",
    powerUsers: ["AL", "GH", "NT", "+3"]
  },
  {
    name: "Data Science",
    category: "Technical teams",
    dailyActive: "16 / 28",
    spend: "$120K",
    avgPerPerson: "$4.3K",
    powerUsers: ["MC", "KJ", "ET", "+2"]
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
    powerUsers: ["PC", "EG", "TM", "+2"]
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

type Props = {
  /** When true, the outer card renders its own rounded border + shadow. When false, the caller wraps it. */
  standalone?: boolean;
};

export function LandingEnterpriseHero({ standalone = false }: Props) {
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
            <span>Department view</span>
          </div>

          <p className="mt-2 text-[13px] leading-6 text-[#5A6886] md:text-[15px] md:leading-7">
            See where AI usage is concentrated across departments.
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

        <div className="relative z-10 mt-4 grid gap-4 md:mt-5 lg:grid-cols-[1.05fr_0.95fr]">
          <DepartmentTable
            selectedDepartment={selectedDepartment}
            onSelect={(name) =>
              setSelectedDepartment((prev) => (prev === name ? null : name))
            }
          />
          <ToolsTable
            rows={visibleTools}
            selectedTool={selectedTool}
            onSelect={(name) =>
              setSelectedTool((prev) => (prev === name ? null : name))
            }
            selectedDepartment={selectedDepartment}
            onClearDepartmentFilter={() => setSelectedDepartment(null)}
          />
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
      <div className="flex items-center gap-3">
        <OpenWorkLogo className="h-8 w-8 text-[#07192C] md:h-9 md:w-9" />
        <span className="text-[16px] font-medium tracking-[-0.03em] text-[#07192C] md:text-[18px]">
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
    <div className="overflow-hidden rounded-[18px] border border-[#e3e7ee] bg-white/90 shadow-[0_1px_0_rgba(7,25,44,0.02)] md:rounded-[20px]">
      <div className="grid grid-cols-[1.15fr_0.9fr_0.55fr_0.7fr_1.1fr] gap-3 border-b border-[#e9edf3] px-4 py-3 text-[11px] font-medium text-[#5A6886] md:px-5 md:py-4 md:text-[13px]">
        <div>Team</div>
        <div>Daily active users</div>
        <div>Spend</div>
        <div>Avg / person</div>
        <div>Power users</div>
      </div>

      {(["Technical teams", "Business teams"] as const).map((group) => (
        <div key={group}>
          <div className="border-b border-[#eef1f5] bg-white/60 px-4 py-2 text-[11px] font-medium text-[#5A6886] md:px-5 md:text-[13px]">
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
                className={`grid w-full grid-cols-[1.15fr_0.9fr_0.55fr_0.7fr_1.1fr] items-center gap-3 border-b border-[#eef1f5] px-4 py-3 text-left transition-colors last:border-b-0 md:px-5 md:py-3.5 ${
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
    <div className="overflow-hidden rounded-[18px] border border-[#e3e7ee] bg-white/90 shadow-[0_1px_0_rgba(7,25,44,0.02)] md:rounded-[20px]">
      <div className="flex items-center justify-between gap-3 border-b border-[#e9edf3] px-4 py-3 md:px-5 md:py-4">
        <h3 className="text-[15px] font-semibold tracking-[-0.02em] text-[#07192C] md:text-[18px]">
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

      <div className="grid grid-cols-[1fr_0.55fr_0.55fr_1.2fr_1.5fr] gap-3 border-b border-[#e9edf3] px-4 py-3 text-[11px] font-medium text-[#5A6886] md:px-5 md:text-[13px]">
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
            className={`grid w-full grid-cols-[1fr_0.55fr_0.55fr_1.2fr_1.5fr] items-center gap-3 border-b border-[#eef1f5] px-4 py-3 text-left transition-colors last:border-b-0 md:px-5 md:py-4 ${
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

function ToolGlyph({ tool }: { tool: string }) {
  if (tool === "OpenWork") {
    return (
      <div className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-[#d9ddeb] bg-[#fbfbfa] text-[#07192C] md:h-8 md:w-8 md:rounded-[9px]">
        <OpenWorkLogo className="h-4 w-4 md:h-5 md:w-5" />
      </div>
    );
  }

  const iconMap: Record<string, React.ReactNode> = {
    Cursor: <span className="text-[12px] font-semibold md:text-[13px]">C</span>,
    "Figma AI": (
      <span className="text-[12px] font-semibold md:text-[13px]">F</span>
    ),
    "Notion AI": (
      <span className="text-[12px] font-semibold md:text-[13px]">N</span>
    ),
    "Zendesk AI": (
      <span className="text-[12px] font-semibold md:text-[13px]">Z</span>
    )
  };

  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-[#d9ddeb] bg-[#f7f8fb] text-[#30405F] md:h-8 md:w-8 md:rounded-[9px]">
      {iconMap[tool] ?? <Brain className="h-3.5 w-3.5 md:h-4 md:w-4" />}
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
      className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold tracking-[-0.02em] md:h-8 md:w-8 md:text-[12px] ${departmentColor(
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

function OpenWorkLogo({
  className = "h-8 w-8",
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} {...props}>
      <path
        d="M20.5 10.5 39 20.7c4.2 2.3 6.3 3.5 7.5 5.6 1.2 2 1.2 4.5 1.2 9.4v8.6c0 4.9 0 7.4-1.2 9.4-1.2 2-3.3 3.2-7.5 5.5L28.8 64M20.5 10.5c-4.2 2.3-6.3 3.5-7.5 5.5-1.2 2.1-1.2 4.6-1.2 9.5v13c0 4.9 0 7.4 1.2 9.5 1.2 2 3.3 3.2 7.5 5.5l8.3 4.5M20.5 10.5 28.8 6c4.2-2.3 6.3-3.5 8.7-3.5 2.4 0 4.5 1.2 8.7 3.5l4 2.2c4.2 2.3 6.3 3.5 7.5 5.5 1.2 2.1 1.2 4.6 1.2 9.5v13c0 4.9 0 7.4-1.2 9.5-1.2 2-3.3 3.2-7.5 5.5l-4 2.2c-4.2 2.3-6.3 3.5-8.7 3.5-2.4 0-4.5-1.2-8.7-3.5"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M27.8 20.2 36.8 25c3 1.6 4.5 2.5 5.3 3.9.8 1.4.8 3 .8 6.4v5.4c0 3.4 0 5-.8 6.4-.8 1.4-2.3 2.3-5.3 3.9l-7.8 4.2c-3 1.6-4.5 2.4-6.2 2.4-1.8 0-3.4-.8-6.3-2.4l-.3-.2c-3-1.6-4.5-2.5-5.3-3.9-.8-1.4-.8-3-.8-6.4v-8.4c0-3.4 0-5 .8-6.4.8-1.4 2.3-2.3 5.3-3.9l9-4.8c1.9-1 2.8-1.5 3.8-1.5s2 .5 3.9 1.5Z"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinejoin="round"
      />
      <path
        d="M18 32h16.5"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <path
        d="M18 41.5h16.5"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default LandingEnterpriseHero;
