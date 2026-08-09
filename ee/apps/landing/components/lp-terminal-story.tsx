const terminalLineCount = 9;

function TerminalLine({ index }: { index: number }) {
  if (index === 0) {
    return (
      <div className="text-[#E2E8F0]">
        <span className="text-[#7DD3FC]">❯</span> share my skills and MCPs with my OpenWork org
      </div>
    );
  }
  if (index === 1) {
    return <div className="text-[#E2E8F0]"><span className="text-[#34D399]">✓ found granola</span> MCP</div>;
  }
  if (index === 2) {
    return <div className="text-[#E2E8F0]"><span className="text-[#34D399]">✓</span> packed <span className="text-[#FBBF24]">meeting-brief</span> skill from SKILL.md</div>;
  }
  if (index === 3) {
    return <div className="text-[#E2E8F0]"><span className="text-[#34D399]">✓</span> added <span className="text-[#7DD3FC]">review-pr</span> command</div>;
  }
  if (index === 4) return <div className="mt-3 text-[#64748B]">› bundling</div>;
  if (index === 5) return <div className="pl-4 text-[#64748B]">mcp/granola.json</div>;
  if (index === 6) return <div className="pl-4 text-[#64748B]">skills/meeting-brief/SKILL.md</div>;
  if (index === 7) return <div className="pl-4 text-[#64748B]">commands/review-pr.md</div>;
  return <div className="mt-3 text-[#E2E8F0]"><span className="text-[#34D399]">✓</span> Shared with your org — one link for the whole team</div>;
}

function TrafficLights() {
  return (
    <div className="flex gap-1.5" aria-hidden="true">
      <span className="h-2.5 w-2.5 rounded-full bg-[#fb7185]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#fbbf24]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#34d399]" />
    </div>
  );
}

export function LpTerminalStory() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="min-h-[410px] overflow-hidden rounded-[24px] bg-[var(--lp-terminal)]">
        <div className="flex h-12 items-center gap-3 border-b border-white/10 px-5">
          <TrafficLights />
          <span className="mono text-[12px] text-[#94a3b8]">agent — terminal</span>
        </div>
        <div className="mono px-6 py-7 text-[13px] leading-[24px]">
          {Array.from({ length: terminalLineCount }, (_, index) => (
            <TerminalLine key={index} index={index} />
          ))}
        </div>
      </div>

      <div className="self-start overflow-hidden rounded-[24px] bg-[var(--lp-tonal)]">
        <div className="flex h-12 items-center justify-between border-b border-[#e5e7eb] px-5">
          <div className="flex items-center gap-3">
            <TrafficLights />
            <span className="text-[12px] font-medium text-[var(--lp-muted)]">OpenWork</span>
          </div>
          <span className="text-[11.5px] text-[var(--lp-faint)]">Your teammate&apos;s view</span>
        </div>
        <div className="flex flex-col p-6">
          <div className="max-w-[390px] rounded-[14px] bg-white px-4 py-3 text-[13px] leading-5 text-[var(--lp-ink)]">
            Prep a brief for tomorrow&apos;s Acme call from my meeting notes.
          </div>
          <div className="mt-5 space-y-2 text-[12px] leading-5 text-[var(--lp-faint)]">
            <div>› Queried the shared Granola MCP for meeting notes</div>
            <div>› Ran Meeting Brief Generator — shared by your team</div>
          </div>
          <p className="mt-5 max-w-[430px] text-[13px] leading-5 text-[var(--lp-ink)]">
            Your brief is ready — deal history, latest notes, and 3 talking points. Saved to your desktop.
          </p>
          <div className="mt-8 flex items-center justify-between gap-3 rounded-full bg-white py-1.5 pl-4 pr-1.5 text-[12.5px] text-[var(--lp-faint)]">
            <span>Describe your task</span>
            <span className="inline-flex h-9 items-center rounded-full bg-[var(--lp-ink)] px-4 text-[12px] font-medium text-white">Run Task</span>
          </div>
        </div>
      </div>
    </div>
  );
}
