import { MEMORY, NEEDS_YOU, RESPONSIBILITIES, RETIRE, STEPS } from "~/content";
import {
  CreateMock,
  MemoryTreeMock,
  NowCardMock,
  PermissionCardMock,
  ResponsibilityCardMock,
  RetiredRowMock,
  TEAM,
  TeamRail,
  WorkingMemoryMock,
} from "~/mocks/product-mocks";
import { Pill, Reveal, Section, SourceNote } from "~/ui/primitives";

export function HowItWorks() {
  const vignettes = [
    <div key="create" className="card p-5">
      <CreateMock />
    </div>,
    <div key="assign" className="card p-4">
      <div className="rounded-2xl border border-line bg-panel p-2">
        <p className="px-2 py-1.5 text-sm text-mist">Assign work to Quill…</p>
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[10px] text-mist">⌘ Enter to assign</span>
          <span className="rounded-xl border border-spark/35 bg-spark/16 px-3 py-1 text-xs font-medium text-[#adc3ff]">Assign</span>
        </div>
      </div>
      <p className="mt-3 px-1 text-[11px] text-mist">One assignment becomes a durable OpenWork thread.</p>
    </div>,
    <div key="return" className="card p-3">
      <TeamRail selected="Editor" compact />
    </div>,
  ];

  return (
    <Section
      id="how"
      eyebrow="How it works"
      title="Create, assign, return."
      lead="Three moments, one durable relationship. Nothing here is a wizard, a dashboard, or a separate task system."
    >
      <ol className="mt-12 grid gap-6 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <Reveal key={step.title} delay={index * 80}>
            <li className="flex h-full min-w-0 flex-col">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[12px] text-spark">0{index + 1}</span>
                <h3 className="text-lg font-semibold tracking-[-0.02em] text-snow">{step.title}</h3>
                <span className="text-[13px] text-mist">{step.caption}</span>
              </div>
              <div className="mt-4">{vignettes[index]}</div>
              <p className="mt-4 text-[14px] leading-relaxed text-mist">{step.text}</p>
              <SourceNote source={step.source} />
            </li>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}

export function Memory() {
  return (
    <Section id="memory" eyebrow="Memory" title={MEMORY.title} lead={MEMORY.lead}>
      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        <Reveal>
          <MemoryTreeMock files={MEMORY.files} />
        </Reveal>
        <Reveal delay={100}>
          <WorkingMemoryMock />
        </Reveal>
      </div>
      <ul className="mt-8 grid gap-4 md:grid-cols-2">
        {MEMORY.claims.map((claim) => (
          <li key={claim.source} className="card p-5">
            <p className="text-[14px] leading-relaxed text-snow/90">{claim.text}</p>
            <SourceNote source={claim.source} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function NeedsYou() {
  const editor = TEAM[1]!;
  return (
    <Section id="needs-you" eyebrow="Needs you" title={NEEDS_YOU.title} lead={NEEDS_YOU.lead}>
      <div className="mt-12 grid items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Reveal>
          <div className="card p-4">
            <div className="mb-3 flex items-center gap-2.5 border-b border-line pb-3">
              <span className="text-sm font-semibold text-snow">Fix the failing docs build</span>
              <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-amber">
                <span className="status-dot bg-amber" /> Needs you
              </span>
            </div>
            <PermissionCardMock />
          </div>
        </Reveal>
        <Reveal delay={100}>
          <div className="flex flex-col gap-4">
            <div className="card p-3">
              <p className="eyebrow mb-2 px-2 pt-1">Activity</p>
              <NowCardMock member={editor} />
            </div>
            {NEEDS_YOU.claims.map((claim) => (
              <div key={claim.source} className="card p-5">
                <p className="text-[14px] leading-relaxed text-snow/90">{claim.text}</p>
                <SourceNote source={claim.source} />
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

export function Responsibilities() {
  return (
    <Section id="responsibilities" eyebrow="Responsibilities" title={RESPONSIBILITIES.title} lead={RESPONSIBILITIES.lead}>
      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        {RESPONSIBILITIES.placements.map((placement, index) => (
          <Reveal key={placement.name} delay={index * 100}>
            <div className="card flex h-full flex-col p-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xl font-semibold tracking-[-0.02em] text-snow">{placement.name}</h3>
                <Pill tone={index === 0 ? "mint" : "spark"}>{placement.badge}</Pill>
              </div>
              <div className="mt-5">
                <ResponsibilityCardMock placement={index === 0 ? "local" : "cloud"} />
              </div>
              <ul className="mt-5 space-y-2.5">
                {placement.points.map((point) => (
                  <li key={point} className="flex gap-2.5 text-[14px] leading-relaxed text-snow/90">
                    <span className={`mt-[9px] size-1.5 shrink-0 rounded-full ${index === 0 ? "bg-mint" : "bg-spark"}`} aria-hidden="true" />
                    {point}
                  </li>
                ))}
              </ul>
              <SourceNote source={placement.source} />
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div className="card mt-6 grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_320px] md:items-center">
          <div>
            <h3 className="text-lg font-semibold tracking-[-0.02em] text-snow">{RETIRE.title}</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-mist">{RETIRE.text}</p>
            <SourceNote source={RETIRE.source} />
          </div>
          <RetiredRowMock />
        </div>
      </Reveal>
    </Section>
  );
}
