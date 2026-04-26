type Props = {
  className?: string;
};

const items = [
  { name: "Meeting Brief Generator", type: "Skill", tone: "skill" },
  { name: "Contract Reviewer", type: "Skill", tone: "skill" },
  { name: "Outreach CRM", type: "Skill", tone: "skill" },
  { name: "Notion", type: "MCP", tone: "mcp" },
  { name: "HubSpot", type: "MCP", tone: "mcp" },
  { name: "Chrome MCP", type: "MCP", tone: "mcp" },
] as const;

const dotClass: Record<string, string> = {
  skill: "bg-gradient-to-br from-amber-400 to-orange-400",
  command: "bg-gradient-to-br from-violet-400 to-purple-500",
  mcp: "bg-gradient-to-br from-teal-400 to-cyan-500",
};

function LinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    </svg>
  );
}

export function LandingSharePackageCard(props: Props) {
  return (
    <div
      className={[
        "flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-soft bg-surface-card shadow-sm",
        props.className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* App chrome */}
      <div className="flex items-center gap-3 border-b border-border-soft bg-background-muted/80 px-4 py-2.5">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <div className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
          <div className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
        </div>
        <div className="text-[12px] font-medium text-foreground/60">OpenWork</div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4 text-left md:p-5">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-blue-500">
            Workspace Template
          </div>
          <h3 className="text-lg font-medium tracking-tight text-foreground">
            SDR for Acme Company
          </h3>
        </div>

        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-foreground/50">
          Included
        </div>

        <div className="flex flex-col gap-1.5">
          {items.map((item, i) => (
            <div
              key={item.name}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-all ${
                i === 0
                  ? "border-blue-300 bg-blue-50/60 shadow-sm"
                  : "border-border-soft bg-surface-card"
              }`}
            >
              <span
                className={`h-6 w-6 shrink-0 rounded-full ${dotClass[item.tone]}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                  {item.name}
                </span>
                <span className="block text-[11px] text-foreground/60">
                  {item.type}
                </span>
              </span>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-surface-inverse py-2 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(17,24,39,0.12)] transition-colors hover:bg-primary"
        >
          <LinkIcon />
          Generate Share Link
        </button>
      </div>
    </div>
  );
}
