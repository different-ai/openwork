import { CLAUDE_COWORK_ALTERNATIVE_PATH } from "../lib/claude-cowork-alternative";
import {
  anthropic3pCheckedAt,
  anthropic3pSources,
  claudeCowork3pAnswer,
  claudeCowork3pFaq,
  claudeCowork3pHeading,
  threePCards,
  threeWayColumns,
  threeWayRows
} from "../lib/claude-cowork-3p";
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

export function ClaudeCowork3pPage({ stars }: Props) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={stars} />

      <main className="mx-auto w-full max-w-[1040px] px-6 pb-8">
        <CompareHero heading={claudeCowork3pHeading} sub={claudeCowork3pAnswer} note="Enterprise binary deploys with your existing tooling.">
          <DownloadLink className="lp-pill-primary">Download OpenWork free</DownloadLink>
        </CompareHero>

        <CompareSection id="three-way-heading" heading="Enterprise, 3P, or OpenWork">
          <CompareTable
            caption="Claude Enterprise, Claude Desktop on 3P, and OpenWork compared"
            columns={threeWayColumns}
            rows={threeWayRows}
            highlight="openwork"
            sources={anthropic3pSources}
            checkedAt={anthropic3pCheckedAt}
          />
        </CompareSection>

        <div id="cost" className="scroll-mt-28 py-12 md:py-16">
          <CoworkCostCalculator
            defaultUsers={500}
            highlight={["claude-3p", "openwork-enterprise"]}
            heading="Claude on 3P vs OpenWork"
          />
        </div>

        <CompareSection id="why-heading" heading="Why teams on 3P switch">
          <CompareCards cards={threePCards} />
        </CompareSection>

        <div className="py-12 md:py-16">
          <LandingFaq entries={claudeCowork3pFaq} />
        </div>

        <LpCta
          heading="Keep your cloud. Choose your models."
          sub="See OpenWork on your own gateway, with your skills shared."
          primary={{ label: "Talk to us about Enterprise", href: "/enterprise#book" }}
          secondary={{ label: "Download free", href: "/download" }}
          trust="Same price cloud or self-hosted."
        />

        <div className="mt-8">
          <LpArrowLink href={CLAUDE_COWORK_ALTERNATIVE_PATH}>Claude Cowork alternative overview</LpArrowLink>
        </div>

        <div className="mt-16">
          <SiteFooter />
        </div>
      </main>
    </div>
  );
}
