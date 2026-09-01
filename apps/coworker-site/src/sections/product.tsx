import { MEMORY, NEEDS_YOU, RESPONSIBILITIES, STEPS } from "~/content";
import {
  CreateMock,
  MemoryTreeMock,
  PermissionCardMock,
  ResponsibilityCardMock,
  RetiredRowMock,
  TeamRail,
  WorkingMemoryMock,
} from "~/mocks/product-mocks";
import { Pill, Reveal, Section } from "~/ui/primitives";

export function HowItWorks() {
  const vignettes = [
    <div key="create" className="card flex h-full items-center p-5">
      <CreateMock />
    </div>,
    <div key="assign" className="card flex h-full flex-col justify-center p-4">
      <div className="rounded-2xl border border-line bg-panel p-2">
        <p className="px-2 py-1.5 text-sm text-mist">Assign work to Quill…</p>
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[10px] text-mist">⌘ Enter to assign</span>
          <span className="rounded-xl border border-spark/35 bg-spark/16 px-3 py-1 text-xs font-medium text-[#adc3ff]">Assign</span>
        </div>
      </div>
      <div className="mt-3 flex items-end gap-2 px-1">
        <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-panel px-3 py-2 text-[12px] leading-relaxed text-snow">
          Done — <span className="font-mono text-[11px]">workspace/release-note.md</span>, 240 words. Nothing sent.
        </div>
      </div>
    </div>,
    <div key="return" className="card flex h-full flex-col justify-center p-3">
      <TeamRail selected="Editor" compact />
    </div>,
  ];

  return (
    <Section id="how" title="Three moments." lead="Create a coworker, hand it real work, come back to a clear picture. No wizard, no dashboard, no separate task system.">
      <ol className="mt-12 grid gap-8 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <Reveal key={step.title} delay={index * 80}>
            <li className="flex h-full min-w-0 flex-col">
              <div className="h-[224px]">{vignettes[index]}</div>
              <div className="mt-5 flex items-baseline gap-3">
                <span className="font-mono text-[12px] text-spark">0{index + 1}</span>
                <h3 className="text-[17px] font-semibold tracking-[-0.02em] text-snow">{step.title}</h3>
              </div>
              <p className="mt-2 text-[14.5px] leading-relaxed text-mist">{step.text}</p>
            </li>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}

export function Memory() {
  return (
    <Section id="memory" title={MEMORY.title} lead={MEMORY.lead.text}>
      <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Reveal>
          <MemoryTreeMock files={MEMORY.files} />
        </Reveal>
        <Reveal delay={100}>
          <WorkingMemoryMock />
        </Reveal>
      </div>
    </Section>
  );
}

export function NeedsYou() {
  return (
    <Section id="needs-you" title={NEEDS_YOU.title} lead={NEEDS_YOU.lead.text}>
      <Reveal className="mt-12">
        <div className="card mx-auto max-w-2xl p-4">
          <div className="mb-3 flex items-center gap-2.5 border-b border-line pb-3">
            <span className="text-sm font-semibold text-snow">Fix the failing docs build</span>
            <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-amber">
              <span className="status-dot bg-amber" /> Needs you
            </span>
          </div>
          <PermissionCardMock />
        </div>
      </Reveal>
    </Section>
  );
}

export function Responsibilities() {
  return (
    <Section id="responsibilities" title={RESPONSIBILITIES.title} lead={RESPONSIBILITIES.lead}>
      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        {RESPONSIBILITIES.placements.map((placement, index) => (
          <Reveal key={placement.name} delay={index * 100}>
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-3">
                <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-snow">{placement.name}</h3>
                <Pill tone={index === 0 ? "mint" : "spark"}>{placement.badge}</Pill>
              </div>
              <div className="mt-4">
                <ResponsibilityCardMock placement={index === 0 ? "local" : "cloud"} />
              </div>
              <ul className="mt-5 space-y-2">
                {placement.points.map((point) => (
                  <li key={point} className="flex gap-2.5 text-[14.5px] leading-relaxed text-mist">
                    <span className={`mt-[9px] size-1.5 shrink-0 rounded-full ${index === 0 ? "bg-mint" : "bg-spark"}`} aria-hidden="true" />
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal className="mt-14">
        <div className="grid items-center gap-6 border-t border-line pt-8 md:grid-cols-[minmax(0,1fr)_320px]">
          <p className="max-w-xl text-[14.5px] leading-relaxed text-mist">
            <span className="font-semibold text-snow">Retire without regret. </span>
            {RESPONSIBILITIES.retire.text}
          </p>
          <RetiredRowMock />
        </div>
      </Reveal>
    </Section>
  );
}
