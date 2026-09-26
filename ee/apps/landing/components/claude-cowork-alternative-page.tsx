import { CLAUDE_COWORK_3P_PATH } from "../lib/claude-cowork-3p";
import { CoworkCostCalculator } from "./cowork-cost-calculator";
import { DownloadLink } from "./download-link";
import { LandingFaq } from "./landing-faq";
import { LpCta } from "./lp-cta";
import { LpArrowLink } from "./lp-primitives";
import { OpenWorkMark } from "./openwork-mark";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import {
  MIGRATION_GUIDE_PATH,
  alternativeSections,
  claudeCoworkAlternativeAnswer,
  claudeCoworkAlternativeFaq,
  comparisonRows
} from "../lib/claude-cowork-alternative";

type Props = {
  stars: string;
};

export function ClaudeCoworkAlternativePage({ stars }: Props) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={stars} />

      <main className="mx-auto w-full max-w-[1040px] px-6 pb-8">
        <header className="border-b border-[var(--lp-border)] pb-14 pt-16 md:pb-20 md:pt-[88px]">
          <div className="text-[15px] text-[var(--lp-muted)]">Claude Cowork alternative</div>
          <h1 className="mt-5 max-w-[820px] text-[44px] font-light leading-[49px] tracking-[-0.02em] md:text-[58px] md:leading-[62px]">
            The free, open-source alternative to Claude Cowork
          </h1>
          <p className="mt-7 max-w-[720px] text-[18px] leading-[29px] text-[var(--lp-body)]">
            {claudeCoworkAlternativeAnswer}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <DownloadLink className="lp-pill-primary">Download OpenWork free</DownloadLink>
            <a href="/docs/start-here/get-started" className="lp-pill-secondary">
              Read the docs
            </a>
          </div>
          <p className="mt-4 text-[13px] text-[var(--lp-muted)]">
            For macOS, Windows, and Linux. No account needed.
          </p>
        </header>

        <section aria-labelledby="comparison-heading" className="py-14 md:py-20">
          <div className="text-[15px] text-[var(--lp-muted)]">Side by side</div>
          <h2
            id="comparison-heading"
            className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em] md:text-[42px] md:leading-[48px]"
          >
            OpenWork vs Claude Cowork
          </h2>
          <div className="mt-9 md:hidden">
            {comparisonRows.map((row) => (
              <div key={row.label} className="border-b border-[var(--lp-border)] py-5">
                <div className="text-[15px] font-medium text-[var(--lp-ink)]">{row.label}</div>
                <div className="mt-3 grid grid-cols-2 gap-3 rounded-[12px] bg-[var(--lp-tonal)] p-3 text-[13.5px] leading-[20px]">
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--lp-ink)]">
                      <OpenWorkMark className="h-3.5 w-3.5 object-contain" />
                      OpenWork
                    </div>
                    <div className="text-[var(--lp-ink)]">{row.openwork}</div>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[12px] font-medium text-[var(--lp-muted)]">Claude Cowork</div>
                    <div className="text-[var(--lp-body)]">{row.cowork}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-9 hidden md:block">
            <table className="w-full border-collapse text-left text-[14.5px] leading-[22px]">
              <thead>
                <tr className="border-b border-[var(--lp-border)]">
                  <th scope="col" className="w-[26%] py-3.5 pr-4 text-[13px] font-medium text-[var(--lp-muted)]">
                    <span className="sr-only">Feature</span>
                  </th>
                  <th scope="col" className="w-[40%] py-3.5 pr-4 text-[13px] font-semibold text-[var(--lp-ink)]">
                    <span className="inline-flex items-center gap-2">
                      <OpenWorkMark className="h-5 w-5 object-contain" />
                      OpenWork
                    </span>
                  </th>
                  <th scope="col" className="py-3.5 text-[13px] font-medium text-[var(--lp-muted)]">
                    Claude Cowork
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.label} className="border-b border-[var(--lp-border)] align-top">
                    <th scope="row" className="py-4 pr-4 font-medium text-[var(--lp-ink)]">
                      {row.label}
                    </th>
                    <td className="py-4 pr-4 text-[var(--lp-ink)]">{row.openwork}</td>
                    <td className="py-4 text-[var(--lp-body)]">{row.cowork}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-5 text-[13px] leading-[20px] text-[var(--lp-muted)]">
            Claude Cowork details summarize Anthropic&apos;s public product information.
            Check Anthropic&apos;s site for current plans.
          </p>
        </section>

        <div className="border-t border-[var(--lp-border)] py-14 md:py-20">
          <CoworkCostCalculator />
          <p className="mt-6 text-[14px] text-[var(--lp-body)]">
            Running Claude Desktop on Bedrock, Vertex, or Foundry?{" "}
            <a
              href={CLAUDE_COWORK_3P_PATH}
              className="font-medium text-[var(--lp-ink)] underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]"
            >
              Compare OpenWork with Claude on 3P
            </a>
          </p>
        </div>

        <section
          aria-labelledby="why-heading"
          className="border-t border-[var(--lp-border)] py-14 md:py-20"
        >
          <div className="text-[15px] text-[var(--lp-muted)]">Why people switch</div>
          <h2
            id="why-heading"
            className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em] md:text-[42px] md:leading-[48px]"
          >
            Your models, your machine, your team.
          </h2>
          <div className="mt-9 grid gap-4 md:grid-cols-2">
            {alternativeSections.map((section) => (
              <article key={section.title} className="flex flex-col rounded-[20px] bg-[var(--lp-tonal)] p-6">
                <h3 className="text-[17px] font-semibold">{section.title}</h3>
                <p className="mt-2 flex-1 text-[14.5px] leading-[23px] text-[var(--lp-body)]">
                  {section.body}
                </p>
                <div className="mt-5">
                  <LpArrowLink href={section.link.href}>{section.link.label}</LpArrowLink>
                </div>
              </article>
            ))}
          </div>
        </section>

        <div className="border-t border-[var(--lp-border)] py-14 md:py-20">
          <LandingFaq entries={claudeCoworkAlternativeFaq} />
        </div>

        <LpCta
          heading="Move from Claude Cowork without rebuilding your setup."
          sub="Your SKILL.md skills, plugins, and MCP servers carry over. Start with one real task and keep Cowork until it works end to end."
          primary={{ label: "Download OpenWork free", href: "/download" }}
          secondary={{ label: "Read the migration guide", href: MIGRATION_GUIDE_PATH }}
          trust="Free and open source for macOS, Windows, and Linux."
        />

        <div className="mt-16">
          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
