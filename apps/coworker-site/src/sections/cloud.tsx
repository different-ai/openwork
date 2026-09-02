import { useState } from "react";
import { AGENT, CLOUD, NOTIFY } from "~/content";
import { ButtonLink, Pill, Reveal, Section } from "~/ui/primitives";

function Points({ points, tone }: { points: Array<{ text: string }>; tone: "mint" | "spark" }) {
  return (
    <ul className="mt-5 space-y-2.5">
      {points.map((point) => (
        <li key={point.text} className="flex gap-2.5 text-[14.5px] leading-relaxed text-mist">
          <span className={`mt-[9px] size-1.5 shrink-0 rounded-full ${tone === "mint" ? "bg-mint" : "bg-spark"}`} aria-hidden="true" />
          {point.text}
        </li>
      ))}
    </ul>
  );
}

/** Free on your Mac; OpenWork Cloud is the paid platform underneath and the CTA that matters. */
export function Cloud() {
  return (
    <Section id="cloud" title={CLOUD.title} lead={CLOUD.lead}>
      <div className="mt-12 grid gap-5 lg:grid-cols-2">
        <Reveal>
          <div className="card flex h-full flex-col p-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-snow">{CLOUD.local.name}</h3>
              <Pill tone="mint">{CLOUD.local.badge}</Pill>
            </div>
            <Points points={CLOUD.local.points} tone="mint" />
            <div className="mt-auto pt-6">
              <ButtonLink href={CLOUD.local.cta.href} variant="ghost">
                {CLOUD.local.cta.label}
              </ButtonLink>
            </div>
          </div>
        </Reveal>
        <Reveal delay={100}>
          <div className="glass flex h-full flex-col rounded-[20px] p-6 ring-1 ring-spark/20">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-snow">{CLOUD.cloud.name}</h3>
              <Pill tone="spark">{CLOUD.cloud.badge}</Pill>
            </div>
            <p className="mt-2 text-[13px] text-mist">{CLOUD.cloud.price.text}</p>
            <Points points={CLOUD.cloud.points} tone="spark" />
            <div className="mt-auto flex flex-wrap items-center gap-3 pt-6">
              <ButtonLink href={CLOUD.cloud.cta.href} rel="noreferrer">
                {CLOUD.cloud.cta.label}
              </ButtonLink>
              <a href={CLOUD.cloud.secondary.href} rel="noreferrer" className="text-[13px] font-medium text-mist transition-colors hover:text-snow">
                {CLOUD.cloud.secondary.label} →
              </a>
            </div>
          </div>
        </Reveal>
      </div>

      <Reveal className="mt-8">
        <div className="grid gap-6 border-t border-line pt-7 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <p className="max-w-2xl text-[14px] leading-relaxed text-mist">{CLOUD.direction.text}</p>
          <div className="flex items-center gap-4 text-[13.5px]">
            <span className="text-mist">{CLOUD.teams.text.split("?")[0]}?</span>
            <a href={CLOUD.teams.cta.href} rel="noreferrer" className="shrink-0 font-medium text-snow underline decoration-white/25 underline-offset-4 hover:decoration-white/60">
              {CLOUD.teams.cta.label} →
            </a>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

/** A copyable prompt that points the person's own agent at /start.md on whatever origin this page is served from. */
export function AgentHandoff() {
  const [copied, setCopied] = useState(false);
  const startUrl = typeof window === "undefined" ? "/start.md" : `${window.location.origin}/start.md`;
  const prompt = AGENT.promptTemplate(startUrl);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be denied; the prompt stays selectable below.
    }
  }

  return (
    <Reveal className="mt-14">
      <div className="grid gap-6 border-t border-line pt-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div>
          <h3 className="text-[19px] font-semibold tracking-[-0.02em] text-snow">{AGENT.title}</h3>
          <p className="mt-2 text-[14.5px] leading-relaxed text-mist">{AGENT.text}</p>
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {AGENT.links.map((link) => (
              <a key={link.href} href={link.href} className="text-snow underline decoration-white/25 underline-offset-4 hover:decoration-white/60">
                <span className="font-mono text-[12px]">{link.label}</span> <span className="text-mist">· {link.note}</span>
              </a>
            ))}
          </p>
        </div>
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <span className="text-[11px] font-medium text-mist">Prompt for your agent</span>
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-snow transition-colors hover:bg-white/[0.08]"
            >
              {copied ? "Copied" : "Copy prompt"}
            </button>
          </div>
          <p className="px-4 py-4 text-[13.5px] leading-relaxed text-snow/90">{prompt}</p>
        </div>
      </div>
    </Reveal>
  );
}

export function Notify() {
  return (
    <Reveal className="mt-12">
      <div className="flex flex-col gap-3 border-t border-line pt-7 md:flex-row md:items-center md:justify-between">
        <p className="text-[14px] text-mist">{NOTIFY.title}</p>
        <div className="flex flex-wrap items-center gap-3">
          <ButtonLink href={NOTIFY.releases.href} variant="ghost" className="h-10 text-[13px]" rel="noreferrer">
            {NOTIFY.releases.label}
          </ButtonLink>
          <a href={NOTIFY.email.href} className="text-[13px] font-medium text-mist transition-colors hover:text-snow">
            {NOTIFY.email.label} →
          </a>
        </div>
      </div>
    </Reveal>
  );
}
