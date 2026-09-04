/**
 * The Open Coworker window as one illustration on the light page: the team
 * rail (who is working, who needs you, who is ready), a discussion in the
 * app's own vocabulary — bubbles, one small action line between them, a
 * document card — and the Activity row. Every label and tone is one the app
 * uses (`apps/coworker/src/ui/*`); nothing here is a screenshot and nothing
 * shows a feature the app lacks.
 */
import { CoworkerAvatar, type AvatarColor, type AvatarGlasses } from "./coworker-brand";

export type TeamMember = {
  name: string;
  role: string;
  color: AvatarColor;
  glasses: AvatarGlasses;
  state: "working" | "attention" | "ready";
  label: string;
  line: string;
  when: string;
};

/** Three coworkers from the app's own role catalog (`apps/coworker/electron/team.mjs`). */
export const TEAM: TeamMember[] = [
  { name: "Scout", role: "Research", color: "blue", glasses: "round", state: "working", label: "Working", line: "Working on compare the three onboarding flows", when: "now" },
  { name: "Editor", role: "Writing", color: "rose", glasses: "square", state: "attention", label: "Needs you", line: "Wants to run a command: pnpm test", when: "now" },
  { name: "Ops", role: "Operations", color: "mint", glasses: "none", state: "ready", label: "Ready", line: "Next: Weekly digest · tomorrow 9:00 AM", when: "3h" },
];

const TONE: Record<TeamMember["state"], { dot: string; text: string }> = {
  working: { dot: "#5b8def", text: "#7fa6f5" },
  attention: { dot: "#d9a441", text: "#e3b45a" },
  ready: { dot: "#5fb59a", text: "#7cc6ad" },
};

const INK = "#0b0e14";
const PANEL = "#141924";
const PANEL_2 = "#1b2130";
const LINE = "rgba(255,255,255,0.08)";
const SNOW = "#f4f6fa";
const MIST = "#9aa3b2";

function Dot({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />;
}

function TeamRail({ selected }: { selected: string }) {
  return (
    <div className="flex flex-col gap-1">
      {TEAM.map((member) => (
        <div
          key={member.name}
          className="flex items-start gap-2.5 rounded-2xl px-2.5 py-2.5"
          style={member.name === selected ? { background: "rgba(255,255,255,0.08)", boxShadow: `inset 0 0 0 1px ${LINE}` } : undefined}
        >
          <span className="mt-0.5 shrink-0">
            <CoworkerAvatar name={member.name} color={member.color} glasses={member.glasses} size={36} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[13px] font-semibold" style={{ color: SNOW }}>{member.name}</span>
              <span className="shrink-0 text-[10px]" style={{ color: MIST }}>{member.when}</span>
            </span>
            <span className="mt-1 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: TONE[member.state].text }}>
              <Dot color={TONE[member.state].dot} />
              {member.label}
            </span>
            <span className="mt-0.5 block truncate text-[11px] leading-[1.35]" style={{ color: MIST }}>{member.line}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Thread() {
  const scout = TEAM[0]!;
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="flex justify-end">
        <p className="max-w-[82%] rounded-2xl rounded-br-md px-3.5 py-2.5 leading-relaxed" style={{ background: SNOW, color: INK }}>
          Compare the three onboarding flows you flagged against ours and write a one-page brief.
        </p>
      </div>
      {/* One small centered line between bubbles: what the coworker thought through and did. */}
      <p className="flex flex-wrap items-center justify-center gap-x-4 px-6 text-center text-[11px]" style={{ color: MIST }}>
        <span>Thought through ›</span>
        <span className="inline-flex items-center gap-1.5">
          Worked with your files and the web · 3 steps
          <Dot color={TONE.ready.dot} />
        </span>
      </p>
      <div className="flex items-end gap-2">
        <CoworkerAvatar name={scout.name} color={scout.color} glasses={scout.glasses} size={24} />
        <div className="max-w-[82%] rounded-2xl rounded-bl-md px-3.5 py-2.5 leading-relaxed" style={{ background: PANEL_2, color: SNOW }}>
          Ours asks for the most up front; the other three defer the model choice. The brief has the three differences that matter and one recommendation.
          <div className="mt-2.5 flex items-center justify-between gap-3 rounded-xl px-3 py-2" style={{ background: INK, boxShadow: `inset 0 0 0 1px ${LINE}` }}>
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-semibold" style={{ color: SNOW }}>Onboarding compare</span>
              <span className="block truncate text-[11px]" style={{ color: MIST }}>Three differences, one recommendation.</span>
            </span>
            <span className="shrink-0 text-[11px] font-medium" style={{ color: SNOW }}>Open</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2.5 px-1 pt-1 text-[12px]" style={{ color: MIST }}>
        <CoworkerAvatar name={scout.name} color={scout.color} glasses={scout.glasses} size={20} />
        <span aria-hidden="true" className="flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full" style={{ background: MIST }} />
          <span className="h-1 w-1 rounded-full" style={{ background: MIST, opacity: 0.7 }} />
          <span className="h-1 w-1 rounded-full" style={{ background: MIST, opacity: 0.45 }} />
        </span>
        Scout is putting it together…
      </div>
    </div>
  );
}

function Activity() {
  const rows = [
    ["Documents", "1 document · updated now"],
    ["Workers", "1 Worker running"],
    ["Assignments", "2 assignments · 1 on a schedule"],
  ];
  return (
    <div className="text-[12px]">
      <p className="px-1 pb-2 text-[11px]" style={{ color: MIST }}>Scout is on your discussion. Weekly digest ran this morning.</p>
      <div className="divide-y rounded-xl" style={{ borderColor: LINE, boxShadow: `inset 0 0 0 1px ${LINE}` }}>
        {rows.map(([name, line]) => (
          <div key={name} className="flex items-center justify-between gap-3 px-3 py-2.5" style={{ borderColor: LINE }}>
            <span className="min-w-0">
              <span className="block text-[12px] font-medium" style={{ color: SNOW }}>{name}</span>
              <span className="block truncate text-[11px]" style={{ color: MIST }}>{line}</span>
            </span>
            <span aria-hidden="true" style={{ color: MIST }}>›</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The whole window, at the landing's product-frame width. */
export function CoworkerVignette() {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--lp-border)] shadow-[0_30px_80px_-40px_rgba(1,22,39,0.45)]" style={{ background: INK }} data-testid="coworker-vignette">
      <div className="flex h-[52px] items-center gap-3 border-b px-4" style={{ borderColor: LINE }}>
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "rgba(255,255,255,0.14)" }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "rgba(255,255,255,0.14)" }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "rgba(255,255,255,0.14)" }} />
        </span>
        <CoworkerAvatar name="Scout" color="blue" glasses="round" size={26} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold" style={{ color: SNOW }}>Scout</span>
          <span className="block truncate text-[11px]" style={{ color: MIST }}>Compare the three onboarding flows against ours · 3</span>
        </span>
        <span className="shrink-0 text-[12px]" style={{ color: TONE.working.text }}>Working</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_280px]">
        <aside className="hidden border-r p-3 md:block" style={{ borderColor: LINE, background: PANEL }}>
          <p className="mb-2 px-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: MIST }}>Coworkers</p>
          <TeamRail selected="Scout" />
        </aside>
        <main className="min-w-0 p-5">
          <Thread />
          <div className="mt-5 flex items-center gap-2 rounded-[20px] border px-4 py-2" style={{ borderColor: LINE, background: "rgba(20,25,36,0.6)" }}>
            <span className="flex-1 text-[13px]" style={{ color: "rgba(154,163,178,0.65)" }}>Message Scout</span>
            <span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: "rgba(255,255,255,0.12)" }} aria-hidden="true">
              <svg viewBox="0 0 16 16" width="12" height="12"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill={SNOW} /></svg>
            </span>
          </div>
          <p className="mt-1.5 px-4 text-[10px]" style={{ color: "rgba(154,163,178,0.7)" }}>Enter sends it next · 2 assignments · 1 Worker · 1 document</p>
        </main>
        <aside className="hidden border-l p-3 xl:block" style={{ borderColor: LINE, background: PANEL }}>
          <p className="mb-2 px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: MIST }}>Activity</p>
          <Activity />
        </aside>
      </div>
    </div>
  );
}
