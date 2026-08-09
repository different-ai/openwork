import { Check, CheckCircle2 } from "lucide-react";

import { LpAlphaBadge } from "./lp-primitives";
import { OpenWorkMark } from "./openwork-mark";

type CoworkSupport = "check" | "none" | "limited";

type OpenWorkSupport = "check" | "soon";

type ParityRow = {
  capability: string;
  cowork: CoworkSupport;
  openwork?: OpenWorkSupport;
  badge?: "alpha" | "openwork";
  highlighted?: boolean;
};

const rows: ParityRow[] = [
  { capability: "Chat on your files and tools", cowork: "check" },
  { capability: "Claude models (Sonnet, Opus, Haiku)", cowork: "check" },
  { capability: "GPT-5, Gemini, Mistral, and local models", cowork: "none" },
  { capability: "Scheduled tasks", cowork: "check", badge: "alpha" },
  {
    capability: "Dispatch — assign tasks from your phone",
    cowork: "check",
    openwork: "soon"
  },
  {
    capability: "Live artifacts — auto-refreshing dashboards",
    cowork: "check",
    openwork: "soon"
  },
  { capability: "Browser automation", cowork: "limited" },
  { capability: "Anthropic-compatible plugins and skills", cowork: "check" },
  { capability: "Instant org-wide skill and MCP sharing", cowork: "none" },
  {
    capability: "MCP gateway usable from any client",
    cowork: "none",
    badge: "openwork",
    highlighted: true
  },
  { capability: "Self-host or managed private instance", cowork: "none" },
  { capability: "Open source — audit it, fork it, own it", cowork: "none" }
];

function OpenWorkCheck() {
  return (
    <span
      className="inline-flex items-center justify-center text-[var(--lp-ink)]"
      aria-label="Included"
    >
      <CheckCircle2 className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}

function CoworkCell({ support }: { support: CoworkSupport }) {
  if (support === "limited") {
    return <span className="text-[13px] text-[var(--lp-faint)]">Limited</span>;
  }

  if (support === "none") {
    return <span className="text-[15px] text-[var(--lp-faint)]">—</span>;
  }

  return (
    <Check
      className="h-5 w-5 text-[var(--lp-faint)]"
      strokeWidth={1.75}
      aria-label="Included"
    />
  );
}

function OpenWorkCell({ support }: { support?: OpenWorkSupport }) {
  if (support === "soon") {
    return (
      <span className="text-[12px] font-medium text-[var(--lp-blue)]">
        Coming soon
      </span>
    );
  }

  return <OpenWorkCheck />;
}

function Capability({ row }: { row: ParityRow }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-2 text-[15px] text-[var(--lp-ink)] ${
        row.highlighted ? "font-semibold" : "font-normal"
      }`}
    >
      <span>{row.capability}</span>
      {row.badge === "alpha" ? <LpAlphaBadge /> : null}
      {row.badge === "openwork" ? (
        <span className="rounded-full bg-[#dbeafe] px-2 py-0.5 text-[9.5px] font-bold tracking-[0.08em] text-[var(--lp-blue)]">
          OPENWORK ONLY
        </span>
      ) : null}
    </div>
  );
}

export function LpParityTable() {
  return (
    <div>
      <div className="md:hidden">
        {rows.map((row) => (
          <div
            key={row.capability}
            className={`border-b border-[#E8EDF3] px-1 py-5 ${
              row.highlighted ? "rounded-[12px] bg-[#f0f7ff] px-4" : ""
            }`}
          >
            <Capability row={row} />
            <div className="mt-4 grid grid-cols-2 gap-3 rounded-[12px] bg-[var(--lp-tonal)] p-3">
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--lp-muted)]">
                  <OpenWorkMark className="h-3.5 w-3.5 object-contain" />
                  OpenWork
                </div>
                <OpenWorkCell support={row.openwork} />
              </div>
              <div>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--lp-muted)]">
                  Claude Cowork
                </div>
                <CoworkCell support={row.cowork} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block">
        <div className="flex items-center border-b border-[var(--lp-border)] px-5 py-3.5">
          <div className="flex-1 text-[12px] font-semibold tracking-[0.1em] text-[var(--lp-faint)]">
            CAPABILITY
          </div>
          <div className="flex w-40 items-center justify-center gap-2 text-[13px] font-semibold text-[var(--lp-ink)]">
            <OpenWorkMark className="h-5 w-5 object-contain" />
            OpenWork
          </div>
          <div className="w-40 text-center text-[13px] font-medium text-[var(--lp-muted)]">
            Claude Cowork
          </div>
        </div>

        {rows.map((row) => (
          <div
            key={row.capability}
            className={`group flex items-center border-b border-[#F1F5F9] px-5 py-[15px] transition-colors duration-150 hover:bg-[var(--lp-tonal)] ${
              row.highlighted ? "rounded-[10px] bg-[#f0f7ff]" : ""
            }`}
          >
            <div className="flex-1">
              <Capability row={row} />
            </div>
            <div className="flex w-40 justify-center">
              <OpenWorkCell support={row.openwork} />
            </div>
            <div className="flex w-40 justify-center">
              <CoworkCell support={row.cowork} />
            </div>
          </div>
        ))}

      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-5 text-[13px] text-[var(--lp-faint)] md:px-5">
        <span>
          Migrating from Cowork? Your SKILL.md files and MCP servers work as-is.
        </span>
        <a
          href="/docs/start-here/migrate-from-claude-cowork"
          className="text-[var(--lp-ink)] underline decoration-1 underline-offset-4"
        >
          See the migration guide
        </a>
      </div>
    </div>
  );
}
