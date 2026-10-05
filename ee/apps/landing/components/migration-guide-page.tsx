import { HeroDownloadButton } from "./hero-download-button";
import { LandingFaq } from "./landing-faq";
import { LandingHeroPrompt } from "./landing-hero-prompt";
import { LpCta } from "./lp-cta";
import { LpHeroBackground } from "./lp-hero-background";
import { LpParityTable } from "./lp-parity-table";
import { LpSectionHeader, LpTonalCard } from "./lp-primitives";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import {
  MIGRATION_PROMPT,
  migrationFaq,
  migrationMoves,
  migrationStays,
  migrationSteps
} from "../lib/claude-cowork-migration";

type Props = {
  stars: string;
};

export function MigrationGuidePage({ stars }: Props) {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <LpHeroBackground />

      <div className="relative z-10">
        <SiteNav stars={stars} active="docs" />

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          <section
            aria-labelledby="migration-heading"
            className="grid items-start gap-10 pt-16 md:pt-24 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-14"
          >
            <div className="min-w-0">
              <p className="mb-5 text-[13px] leading-relaxed text-[var(--lp-muted)]">
                Claude Cowork migration guide
              </p>
              <h1
                id="migration-heading"
                className="text-[clamp(2.5rem,4.4vw,3.25rem)] font-medium leading-[1.08] tracking-[-0.045em]"
              >
                <span className="block">Switch from Claude Cowork</span>{" "}
                <span className="block">in one prompt.</span>
              </h1>
              <p className="mt-6 max-w-xl text-[17px] leading-[1.6] text-[var(--lp-body)] lg:text-lg">
                Bring your Cowork plugins and Claude skills to OpenWork, the
                open-source Claude Cowork alternative. Your agent moves them and
                tells you what is left.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <HeroDownloadButton />
                <a href="/migrate.md" className="lp-btn lp-btn--secondary">
                  Read what the agent will do
                </a>
              </div>
              <p className="mt-4 text-xs text-[var(--lp-muted)]">
                Free and open source · Needs an owner or admin account to share plugins with your team
              </p>
            </div>

            <div className="flex min-w-0 lg:justify-end">
              <LandingHeroPrompt
                className="w-full lg:max-w-[480px]"
                prompt={MIGRATION_PROMPT}
                heading="Paste this into Claude Code"
                description="Or any agent that can run commands on your computer. It asks before it uploads anything."
                variant="cowork-migration"
                placement="migration-guide"
                showPrompt
              />
            </div>
          </section>

          <section className="mt-20 lg:mt-[120px]" aria-labelledby="moves-heading">
            <LpSectionHeader label="What moves" heading="Your plugins and skills, ready on day one." />
            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {migrationMoves.map((item) => (
                <LpTonalCard key={item.title} className="p-7">
                  <h3 className="text-[17px] font-medium">{item.title}</h3>
                  <p className="mt-2 text-[15px] leading-[1.6] text-[var(--lp-body)]">{item.body}</p>
                </LpTonalCard>
              ))}
            </div>
            <p className="mt-6 text-[14px] leading-[1.6] text-[var(--lp-muted)]">
              Stays behind: {migrationStays.join("; ")}.
            </p>
          </section>

          <section className="mt-20 lg:mt-[120px]" aria-labelledby="steps-heading">
            <LpSectionHeader label="How it works" heading="Look first. Then move only what you use." />
            <ol className="mt-10 grid gap-4 lg:grid-cols-3">
              {migrationSteps.map((step, index) => (
                <li key={step.title} className="flex flex-col rounded-[24px] border border-[var(--lp-border)] bg-white/60 p-7">
                  <span className="font-pixel text-[28px] leading-none text-[var(--lp-faint)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-5 text-[17px] font-medium">{step.title}</h3>
                  <p className="mt-2 flex-1 text-[15px] leading-[1.6] text-[var(--lp-body)]">{step.body}</p>
                  <code className="mt-6 block overflow-x-auto whitespace-nowrap rounded-xl bg-[var(--lp-tonal)] px-3.5 py-2.5 font-mono text-[12.5px] text-[var(--lp-ink)]">
                    {step.command}
                  </code>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-[14px] leading-[1.6] text-[var(--lp-muted)]">
              No agent? Install the command with{" "}
              <code className="font-mono text-[13px] text-[var(--lp-ink)]">curl -fsSLo /tmp/openwork-install.sh https://openworklabs.com/install.sh</code>,
              {" "}run it with <code className="font-mono text-[13px] text-[var(--lp-ink)]">sh</code>, then{" "}
              <code className="font-mono text-[13px] text-[var(--lp-ink)]">openwork-bootstrap login</code> and the three commands above.
            </p>
          </section>

          <section className="mt-20 lg:mt-[120px]" aria-labelledby="parity-heading">
            <LpSectionHeader label="After the move" heading="Everything Cowork does. No lock-in." />
            <div className="mt-10">
              <LpParityTable showMigrationLink={false} />
            </div>
          </section>

          <div className="mt-[120px] [&_h2]:!text-[36px] [&_h2]:!leading-[42px]">
            <LandingFaq entries={migrationFaq} />
          </div>

          <div className="mt-[120px]">
            <LpCta
              heading="Keep your work. Change your tools."
              sub="Move your Cowork plugins and skills today, and keep Cowork until your real work runs in OpenWork."
              primary={{ label: "Download OpenWork", href: "/download" }}
              secondary={{ label: "Read the agent guide", href: "/migrate.md" }}
              trust="Free & open source · macOS, Windows, Linux"
            />
          </div>

          <div className="mt-16">
            <SiteFooter />
          </div>
        </main>
      </div>
    </div>
  );
}
