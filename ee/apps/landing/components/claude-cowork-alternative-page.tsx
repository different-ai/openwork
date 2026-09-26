import { CLAUDE_COWORK_3P_PATH } from "../lib/claude-cowork-3p";
import {
  MIGRATION_GUIDE_PATH,
  alternativeCards,
  claudeCoworkAlternativeAnswer,
  claudeCoworkAlternativeFaq,
  claudeCoworkAlternativeHeading,
  comparisonColumns,
  comparisonRows,
  comparisonSources
} from "../lib/claude-cowork-alternative";
import { CoworkCostCalculator } from "./cowork-cost-calculator";
import { DownloadLink } from "./download-link";
import { LandingFaq } from "./landing-faq";
import { CompareCards, CompareHero, CompareSection, CompareTable } from "./lp-compare";
import { LpCta } from "./lp-cta";
import { LpArrowLink } from "./lp-primitives";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
};

export function ClaudeCoworkAlternativePage({ stars }: Props) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={stars} />

      <main className="mx-auto w-full max-w-[1040px] px-6 pb-8">
        <CompareHero
          heading={claudeCoworkAlternativeHeading}
          sub={claudeCoworkAlternativeAnswer}
          note="No account needed."
        >
          <DownloadLink className="lp-pill-primary">Download OpenWork free</DownloadLink>
        </CompareHero>

        <CompareSection id="comparison-heading" heading="OpenWork vs Claude Cowork" narrow>
          <CompareTable
            caption="OpenWork compared with Claude Cowork"
            columns={comparisonColumns}
            rows={comparisonRows}
            highlight="openwork"
            sources={comparisonSources}
          />
        </CompareSection>

        <div id="cost" className="scroll-mt-28 py-12 md:py-16">
          <CoworkCostCalculator />
          <div className="mt-6">
            <LpArrowLink href={CLAUDE_COWORK_3P_PATH}>On Bedrock, Vertex, or Foundry? Compare with Claude on 3P</LpArrowLink>
          </div>
        </div>

        <CompareSection id="why-heading" heading="Why people switch">
          <CompareCards cards={alternativeCards} />
        </CompareSection>

        <div className="py-12 md:py-16">
          <LandingFaq entries={claudeCoworkAlternativeFaq} />
        </div>

        <LpCta
          heading="Bring your Cowork setup with you."
          sub="Skills, plugins, and MCP servers carry over."
          primary={{ label: "Download OpenWork free", href: "/download" }}
          secondary={{ label: "Migration guide", href: MIGRATION_GUIDE_PATH }}
          trust="macOS, Windows, and Linux."
        />

        <div className="mt-16">
          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
