import { CoworkCostCalculator } from "./cowork-cost-calculator";
import { LandingFaq } from "./landing-faq";
import { LpCta } from "./lp-cta";
import { OpenWorkMark } from "./openwork-mark";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import { CLAUDE_COWORK_ALTERNATIVE_PATH } from "../lib/claude-cowork-alternative";
import {
  anthropic3pCheckedAt,
  anthropic3pSources,
  claudeCowork3pAnswer,
  claudeCowork3pFaq,
  threePSections,
  threeWayRows
} from "../lib/claude-cowork-3p";

type Props = {
  stars: string;
};

const columns = [
  { key: "enterprise", label: "Claude Enterprise" },
  { key: "thirdParty", label: "Claude Desktop on 3P" },
  { key: "openwork", label: "OpenWork" }
] satisfies { key: "enterprise" | "thirdParty" | "openwork"; label: string }[];

export function ClaudeCowork3pPage({ stars }: Props) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={stars} />

      <main className="mx-auto w-full max-w-[1040px] px-6 pb-8">
        <header className="border-b border-[var(--lp-border)] pb-14 pt-16 md:pb-20 md:pt-[88px]">
          <div className="text-[15px] text-[var(--lp-muted)]">For teams on Bedrock, Vertex, and Foundry</div>
          <h1 className="mt-5 max-w-[860px] text-[44px] font-light leading-[49px] tracking-[-0.02em] md:text-[58px] md:leading-[62px]">
            OpenWork vs Claude Cowork on 3P
          </h1>
          <p className="mt-7 max-w-[760px] text-[18px] leading-[29px] text-[var(--lp-body)]">
            {claudeCowork3pAnswer}
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a href="/enterprise#book" className="lp-pill-primary">
              Talk to us about Enterprise
            </a>
            <a href="#cost" className="lp-pill-secondary">
              Compare costs
            </a>
          </div>
        </header>

        <section aria-labelledby="three-way-heading" className="py-14 md:py-20">
          <div className="text-[15px] text-[var(--lp-muted)]">Side by side</div>
          <h2
            id="three-way-heading"
            className="mt-3 text-[34px] font-light leading-[41px] tracking-[-0.015em] md:text-[42px] md:leading-[48px]"
          >
            Claude Enterprise, Claude on 3P, and OpenWork
          </h2>

          <div className="mt-9 md:hidden">
            {threeWayRows.map((row) => (
              <div key={row.label} className="border-b border-[var(--lp-border)] py-5">
                <div className="text-[15px] font-medium">{row.label}</div>
                <dl className="mt-3 space-y-2 rounded-[12px] bg-[var(--lp-tonal)] p-3 text-[13.5px] leading-[20px]">
                  {columns.map((column) => (
                    <div key={column.key}>
                      <dt
                        className={`flex items-center gap-1.5 text-[12px] ${
                          column.key === "openwork" ? "font-semibold text-[var(--lp-ink)]" : "font-medium text-[var(--lp-muted)]"
                        }`}
                      >
                        {column.key === "openwork" ? <OpenWorkMark className="h-3.5 w-3.5 object-contain" /> : null}
                        {column.label}
                      </dt>
                      <dd className={column.key === "openwork" ? "text-[var(--lp-ink)]" : "text-[var(--lp-body)]"}>
                        {row[column.key]}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>

          <div className="mt-9 hidden md:block">
            <table className="w-full border-collapse text-left text-[14px] leading-[21px]">
              <thead>
                <tr className="border-b border-[var(--lp-border)]">
                  <th scope="col" className="w-[19%] py-3.5 pr-4">
                    <span className="sr-only">Feature</span>
                  </th>
                  <th scope="col" className="w-[25%] py-3.5 pr-4 text-[13px] font-medium text-[var(--lp-muted)]">
                    Claude Enterprise
                  </th>
                  <th scope="col" className="w-[27%] py-3.5 pr-4 text-[13px] font-medium text-[var(--lp-muted)]">
                    Claude Desktop on 3P
                  </th>
                  <th scope="col" className="py-3.5 text-[13px] font-semibold text-[var(--lp-ink)]">
                    <span className="inline-flex items-center gap-2">
                      <OpenWorkMark className="h-5 w-5 object-contain" />
                      OpenWork
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {threeWayRows.map((row) => (
                  <tr key={row.label} className="border-b border-[var(--lp-border)] align-top">
                    <th scope="row" className="py-4 pr-4 font-medium">{row.label}</th>
                    <td className="py-4 pr-4 text-[var(--lp-body)]">{row.enterprise}</td>
                    <td className="py-4 pr-4 text-[var(--lp-body)]">{row.thirdParty}</td>
                    <td className="py-4 text-[var(--lp-ink)]">{row.openwork}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] leading-[20px] text-[var(--lp-muted)]">
            <span>Anthropic details as of {anthropic3pCheckedAt}:</span>
            {anthropic3pSources.map((source) => (
              <a
                key={source.href}
                href={source.href}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]"
              >
                {source.label}
              </a>
            ))}
          </p>
        </section>

        <section aria-label="Why teams on 3P choose OpenWork" className="border-t border-[var(--lp-border)] py-14 md:py-20">
          <div className="grid gap-4 md:grid-cols-2">
            {threePSections.map((section) => (
              <article key={section.title} className="flex flex-col rounded-[20px] bg-[var(--lp-tonal)] p-6">
                <h2 className="text-[18px] font-semibold leading-[25px]">{section.title}</h2>
                <p className="mt-2 flex-1 text-[14.5px] leading-[23px] text-[var(--lp-body)]">{section.body}</p>
                <ul className="mt-5 space-y-1.5 text-[14px]">
                  {section.links.map((link) => (
                    <li key={link.href}>
                      <a
                        href={link.href}
                        className="font-medium underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <div id="cost" className="scroll-mt-28 border-t border-[var(--lp-border)] py-14 md:py-20">
          <CoworkCostCalculator
            defaultUsers={500}
            highlight={["claude-3p", "openwork-enterprise"]}
            heading="Claude on 3P vs OpenWork, for your team"
          />
        </div>

        <div className="border-t border-[var(--lp-border)] py-14 md:py-20">
          <LandingFaq entries={claudeCowork3pFaq} />
        </div>

        <LpCta
          heading="Keep your cloud. Choose your models."
          sub="See OpenWork running against your own gateway and models, with your skills and MCP servers shared across the team."
          primary={{ label: "Talk to us about Enterprise", href: "/enterprise#book" }}
          secondary={{ label: "Compare with Claude Cowork", href: CLAUDE_COWORK_ALTERNATIVE_PATH }}
          trust="Same price cloud or self-hosted."
        />

        <div className="mt-16">
          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
