/**
 * Product vignettes rendered from the desktop app's own components and copy.
 * They are illustrations of real states (the labels, tones, and layouts match
 * apps/coworker), never screenshots and never invented features.
 */
import type { AvatarColor, AvatarGlasses } from "@/lib/bridge";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { StatusDot } from "~/ui/primitives";

export type TeamMember = {
  name: string;
  role: string;
  color: AvatarColor;
  glasses: AvatarGlasses;
  state: "working" | "attention" | "ready";
  label: string;
  detail: string;
  when: string;
  model: string;
  provider: string;
  memory: string;
  mission: string;
};

export const TEAM: TeamMember[] = [
  {
    name: "Scout",
    role: "Research",
    color: "blue",
    glasses: "round",
    state: "working",
    label: "Working",
    detail: "Compare the three onboarding flows against ours",
    when: "2m",
    model: "claude-sonnet-4-5 · High",
    provider: "anthropic",
    memory: "working.md · 3 long-term notes",
    mission: "Track the persistent-coworker landscape and own the research digest.",
  },
  {
    name: "Editor",
    role: "Writing",
    color: "rose",
    glasses: "square",
    state: "attention",
    label: "Needs you",
    detail: "Wants to run a command: pnpm test",
    when: "now",
    model: "gpt-5 · Medium",
    provider: "openai",
    memory: "working.md · 1 long-term note",
    mission: "Keep every release note, doc, and product string in one plain, confident voice.",
  },
  {
    name: "Ops",
    role: "Operations",
    color: "mint",
    glasses: "none",
    state: "ready",
    label: "Ready",
    detail: "Weekly digest · drafted in workspace/digest-2026-09-01.md",
    when: "3h",
    model: "Engine default",
    provider: "Follows the OpenWork default",
    memory: "working.md · 2 long-term notes",
    mission: "Track active priorities and commitments; surface blockers first.",
  },
];

function tone(state: TeamMember["state"]): "spark" | "amber" | "mint" {
  if (state === "working") return "spark";
  if (state === "attention") return "amber";
  return "mint";
}

function textTone(state: TeamMember["state"]): string {
  if (state === "working") return "text-spark";
  if (state === "attention") return "text-amber";
  return "text-mint";
}

/** The team rail: who is working, who is ready, who needs you. */
export function TeamRail({ selected = "Scout", compact = false }: { selected?: string; compact?: boolean }) {
  return (
    <div className={`flex flex-col ${compact ? "gap-1" : "gap-1.5"}`}>
      {TEAM.map((member) => (
        <div
          key={member.name}
          className={`flex items-start gap-3 rounded-2xl px-2.5 py-2.5 ${
            member.name === selected ? "bg-white/8 ring-1 ring-white/10" : ""
          }`}
        >
          <span className="mt-0.5 flex size-10 shrink-0 items-start justify-center">
            <CoworkerAvatar animated color={member.color} glasses={member.glasses} name={member.name} size={38} working={member.state === "working"} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-semibold text-snow">{member.name}</span>
              <span className="shrink-0 text-[10px] text-mist">{member.when}</span>
            </span>
            <span className={`mt-1 flex items-center gap-1.5 text-[11px] font-medium ${textTone(member.state)}`}>
              <StatusDot tone={tone(member.state)} />
              {member.label}
            </span>
            {!compact ? (
              <span className="mt-1 block truncate text-[11px] leading-[1.35] text-mist">{member.detail}</span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A short thread: assignment, calm tool milestones, and a receipt. */
export function ThreadMock() {
  const scout = TEAM[0]!;
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="flex justify-end">
        <p className="max-w-[86%] rounded-2xl rounded-br-md bg-snow px-3.5 py-2.5 leading-relaxed text-ink">
          Compare the three onboarding flows you flagged against ours and write a one-page brief.
        </p>
      </div>
      <div className="flex items-end gap-2">
        <CoworkerAvatar animated={false} color={scout.color} glasses={scout.glasses} name={scout.name} size={26} />
        <div className="max-w-[86%] rounded-2xl rounded-bl-md bg-panel px-3.5 py-2.5 leading-relaxed text-snow">
          <p className="mb-1 text-[10.5px] font-semibold text-mist">Scout</p>
          Starting with the onboarding notes in <span className="font-mono text-[12px]">memory/long-term/onboarding.md</span>, then the three products.
          <ul className="mt-2.5 space-y-1.5">
            {[
              ["read", "memory/long-term/onboarding.md", "Done"],
              ["webfetch", "3 product pages", "Done"],
              ["write", "workspace/brief-onboarding-compare.md", "Done"],
            ].map(([toolName, target, status]) => (
              <li key={toolName} className="flex items-center gap-2 rounded-lg border border-line bg-ink/70 px-2.5 py-1.5 text-[11.5px]">
                <StatusDot tone="mint" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-snow">{toolName}</span>
                  <span className="text-mist"> · {target}</span>
                </span>
                <span className="text-mist">{status}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex items-end gap-2">
        <span className="size-[26px] shrink-0" />
        <div className="max-w-[86%] rounded-2xl rounded-bl-md bg-panel px-3.5 py-2.5 leading-relaxed text-snow">
          <p className="mb-1 text-[10.5px] font-semibold text-mist">Scout</p>
          Done. <span className="font-mono text-[12px]">workspace/brief-onboarding-compare.md</span> — one page, five sources. I recorded the two
          patterns worth copying in working memory and did not contact anyone.
        </div>
      </div>
    </div>
  );
}

/** The context rail's Now card and facts, as redesigned in the app. */
export function NowCardMock({ member = TEAM[0]! }: { member?: TeamMember }) {
  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-2xl border border-line bg-ink p-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className={`flex min-w-0 items-center gap-2 text-sm font-semibold ${textTone(member.state)}`}>
            <StatusDot tone={tone(member.state)} />
            <span className="truncate">{member.label}</span>
          </span>
          <span className="shrink-0 text-[11px] text-mist">{member.when}</span>
        </div>
        <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-snow">{member.detail}</p>
        <p className="mt-1 text-[11px] text-mist">
          {member.state === "working" ? "Running now ›" : member.state === "attention" ? "Waiting for you — open to respond ›" : "Last worked on this ›"}
        </p>
      </section>
      <section className="divide-y divide-line rounded-2xl border border-line bg-ink">
        {[
          ["Model", member.model, member.provider],
          ["Memory", member.state === "attention" ? "Updated just now" : "Updated 4m ago", member.memory],
          ["Mission", member.mission, ""],
        ].map(([label, value, hint]) => (
          <div key={label} className="flex items-start gap-2.5 px-3.5 py-2.5">
            <span className="w-[52px] shrink-0 pt-px text-[11px] font-medium text-mist">{label}</span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 block text-[12px] leading-relaxed text-snow">{value}</span>
              {hint ? <span className="mt-0.5 block truncate text-[11px] text-mist">{hint}</span> : null}
            </span>
            <span className="text-mist" aria-hidden="true">›</span>
          </div>
        ))}
      </section>
    </div>
  );
}

/** A permission request as it appears inside a thread. */
export function PermissionCardMock() {
  return (
    <section className="rounded-2xl border border-amber/30 bg-amber/6 p-4" aria-label="Permission request illustration">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber">Needs you</p>
      <h3 className="mt-1 text-sm font-semibold text-snow">Editor wants to run a command</h3>
      <ul className="mt-2 space-y-1">
        <li className="truncate rounded-lg bg-ink/70 px-2.5 py-1.5 font-mono text-[11px] text-snow">pnpm test --filter @openwork/docs</li>
      </ul>
      <p className="mt-2 text-xs leading-relaxed text-mist">Nothing happens until you choose. Denying ends this step; the coworker will explain and continue.</p>
      <div className="mt-3 flex flex-wrap gap-1.5" aria-hidden="true">
        <span className="rounded-xl border border-spark/35 bg-spark/16 px-3 py-1.5 text-xs font-medium text-[#adc3ff]">Allow once</span>
        <span className="rounded-xl border border-white/10 bg-white/6 px-3 py-1.5 text-xs font-medium text-snow">Always allow</span>
        <span className="rounded-xl border border-transparent px-3 py-1.5 text-xs font-medium text-rose">Deny</span>
      </div>
    </section>
  );
}

/** The coworker folder, as it exists on disk. */
export function MemoryTreeMock({ files }: { files: Array<{ path: string; note: string }> }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] text-mist">~/.config/openwork/coworkers/scout/</span>
      </div>
      <ul className="divide-y divide-line/60">
        {files.map((file) => (
          <li key={file.path} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
            <span className="font-mono text-[12.5px] text-snow">{file.path}</span>
            <span className="text-right text-[11.5px] text-mist">{file.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** An excerpt of a working memory file, in the shape the coworkers actually write. */
export function WorkingMemoryMock() {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] text-mist">memory/working.md</span>
        <span className="text-[11px] text-mist">Updated 4m ago · by Scout</span>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12px] leading-relaxed text-snow/90">
{`# Working memory — Scout

## Now
- Comparing three onboarding flows against ours; brief drafted.
- Two patterns worth copying: name-first setup, optional role.

## Carrying forward
- Verify pricing claims before the digest (competitive-landscape.md).`}
      </pre>
    </div>
  );
}

/** One responsibility card per placement, in the app's vocabulary. */
export function ResponsibilityCardMock({ placement }: { placement: "local" | "cloud" }) {
  const local = placement === "local";
  return (
    <div className="rounded-2xl border border-line bg-ink p-3.5 text-[12.5px]">
      <div className="flex items-start gap-2.5">
        <span className="mt-1"><StatusDot tone="mint" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-snow">{local ? "Morning signal review" : "Weekly digest"}</p>
            <span className="shrink-0 rounded-full bg-panel px-2 py-0.5 text-[10px] font-medium text-mist">Active</span>
          </div>
          <p className="mt-1 text-xs text-mist">{local ? "Every day at 08:30 (Europe/Berlin)" : "Every Fri at 16:00 (Europe/Berlin)"}</p>
          <p className="mt-1">
            <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${local ? "bg-mint/10 text-mint" : "bg-spark/10 text-spark"}`}>
              {local ? "This Mac" : "OpenWork Cloud"}
            </span>
          </p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-panel px-2.5 py-2">
          <dt className="text-mist">Last run</dt>
          <dd className="mt-0.5 truncate font-medium text-snow">{local ? "Succeeded · Sep 1, 8:31 AM" : "Succeeded · Aug 29, 4:02 PM"}</dd>
        </div>
        <div className="rounded-lg bg-panel px-2.5 py-2">
          <dt className="text-mist">Next run</dt>
          <dd className="mt-0.5 truncate font-medium text-snow">{local ? "Sep 2, 8:30 AM" : "Sep 5, 4:00 PM"}</dd>
        </div>
      </dl>
    </div>
  );
}

/** A retired coworker row with its recoverable state. */
export function RetiredRowMock() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-panel/50 px-3 py-2.5">
      <CoworkerAvatar animated={false} color="violet" glasses="round" name="Archivist" size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-snow">Archivist</span>
        <span className="block truncate text-[11px] text-mist">Records · retired Sep 1, 2:17 PM · 14 files</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
        <span className="rounded-xl border border-spark/35 bg-spark/16 px-3 py-1.5 text-xs font-medium text-[#adc3ff]">Restore</span>
        <span className="px-2 text-xs font-medium text-rose">Delete…</span>
      </span>
    </div>
  );
}

/** Creation: name plus a look, nothing mandatory beyond that. */
export function CreateMock() {
  const swatches: Array<{ id: AvatarColor; hex: string }> = [
    { id: "blue", hex: "#b8c9f0" },
    { id: "violet", hex: "#c8c1e2" },
    { id: "mint", hex: "#b2d5cb" },
    { id: "orange", hex: "#e4c3ad" },
    { id: "rose", hex: "#e2c1cb" },
    { id: "slate", hex: "#e3e6ea" },
  ];
  return (
    <div className="flex items-center gap-5">
      <CoworkerAvatar animated color="orange" glasses="square" name="Quill" size={84} />
      <div className="min-w-0 flex-1">
        <p className="eyebrow">Name</p>
        <div className="mt-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-snow">Quill</div>
        <p className="eyebrow mt-3">Color</p>
        <div className="mt-1.5 flex gap-2" aria-hidden="true">
          {swatches.map((swatch) => (
            <span
              key={swatch.id}
              className={`inline-block size-[18px] rounded-full border ${swatch.id === "orange" ? "border-white/60 ring-2 ring-white/15" : "border-white/20"}`}
              style={{ backgroundColor: swatch.hex }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
