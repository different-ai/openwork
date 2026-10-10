import type { ReactNode } from "react";
import type { Guide, GuideSection } from "../lib/guides";
import { GUIDES_PATH, guidePath, guides } from "../lib/guides";
import { LandingFaq } from "./landing-faq";
import { CompareCards, CompareSection } from "./lp-compare";
import { LpCta } from "./lp-cta";
import { LpArrowLink } from "./lp-primitives";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-[14px] bg-[var(--lp-tonal)] px-4 py-3 text-[13px] leading-[21px] text-[var(--lp-ink)]">
      <code>{code}</code>
    </pre>
  );
}

function SectionBody({ section }: { section: GuideSection }) {
  return (
    <div className="flex flex-col gap-6 text-[16px] leading-[27px] text-[var(--lp-body)]">
      {section.paragraphs?.map((paragraph) => (
        <p key={paragraph} className="max-w-[720px]">
          {paragraph}
        </p>
      ))}

      {section.bullets ? (
        <ul className="flex max-w-[720px] list-disc flex-col gap-2 pl-5">
          {section.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      ) : null}

      {section.steps ? (
        <ol className="flex flex-col gap-6">
          {section.steps.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--lp-tonal)] text-[13px] font-medium text-[var(--lp-ink)]"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[17px] font-medium text-[var(--lp-ink)]">{step.title}</h3>
                <p className="mt-1">{step.body}</p>
                {step.code ? <CodeBlock code={step.code} /> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {section.table ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left text-[14.5px] leading-[22px]">
            <caption className="sr-only">{section.table.caption}</caption>
            <thead>
              <tr>
                {section.table.columns.map((column, index) => (
                  <th
                    key={`${column}-${index}`}
                    scope="col"
                    className="border-b border-[var(--lp-border)] py-3 pr-6 font-medium text-[var(--lp-ink)]"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.table.rows.map((row) => (
                <tr key={row.join("|")}>
                  {row.map((cell, index) =>
                    index === 0 ? (
                      <th
                        key={`${cell}-${index}`}
                        scope="row"
                        className="border-b border-[var(--lp-border)] py-3 pr-6 align-top font-medium text-[var(--lp-ink)]"
                      >
                        {cell}
                      </th>
                    ) : (
                      <td key={`${cell}-${index}`} className="border-b border-[var(--lp-border)] py-3 pr-6 align-top">
                        {cell}
                      </td>
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function PageShell({ stars, children }: { stars: string; children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <SiteNav stars={stars} />
      <main className="mx-auto w-full max-w-[1040px] px-6 pb-8">
        {children}
        <div className="mt-16">
          <SiteFooter />
        </div>
      </main>
    </div>
  );
}

export function GuidePage({ guide, stars }: { guide: Guide; stars: string }) {
  const related = guides.filter((other) => other.slug !== guide.slug);

  return (
    <PageShell stars={stars}>
      <article>
        <header className="pb-10 pt-16 md:pb-14 md:pt-[104px]">
          <nav aria-label="Breadcrumb" className="mb-6 text-[14px] text-[var(--lp-muted)]">
            <a href={GUIDES_PATH} className="transition-colors hover:text-[var(--lp-ink)]">
              Guides
            </a>
          </nav>
          <h1 className="max-w-[860px] text-[38px] font-light leading-[44px] tracking-[-0.025em] [text-wrap:balance] md:text-[54px] md:leading-[60px]">
            {guide.heading}
          </h1>
          <p className="mt-6 max-w-[720px] text-[18px] leading-[29px] text-[var(--lp-body)]">{guide.answer}</p>
        </header>

        {guide.sections.map((section) => (
          <CompareSection key={section.id} id={section.id} heading={section.heading}>
            <SectionBody section={section} />
          </CompareSection>
        ))}

        <CompareSection id="next-heading" heading="Next steps">
          <CompareCards cards={guide.cards} />
        </CompareSection>

        <div className="py-12 md:py-16">
          <LandingFaq entries={guide.faq} />
        </div>
      </article>

      <LpCta
        heading={guide.cta.heading}
        sub={guide.cta.sub}
        primary={guide.cta.primary}
        secondary={guide.cta.secondary}
        trust="Free and open source. macOS, Windows, and Linux."
      />

      <section aria-labelledby="more-guides" className="py-12 md:py-16">
        <h2 id="more-guides" className="mb-6 text-[24px] font-light tracking-[-0.01em]">
          More guides
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {related.map((other) => (
            <li key={other.slug}>
              <LpArrowLink href={guidePath(other)}>{other.label}</LpArrowLink>
            </li>
          ))}
        </ul>
      </section>
    </PageShell>
  );
}

export function GuidesIndexPage({ stars }: { stars: string }) {
  return (
    <PageShell stars={stars}>
      <header className="pb-10 pt-16 md:pb-14 md:pt-[104px]">
        <h1 className="max-w-[820px] text-[40px] font-light leading-[46px] tracking-[-0.025em] md:text-[60px] md:leading-[64px]">
          Guides
        </h1>
        <p className="mt-6 max-w-[620px] text-[18px] leading-[29px] text-[var(--lp-body)]">
          Short answers about how OpenWork works with the tools your teams already use, and how admins keep AI under control.
        </p>
      </header>
      <ul className="grid gap-3 pb-12 sm:grid-cols-2">
        {guides.map((guide) => (
          <li key={guide.slug} className="flex flex-col rounded-[20px] bg-[var(--lp-tonal)] p-6">
            <h2 className="text-[19px] font-medium leading-[26px] tracking-[-0.01em] [text-wrap:balance]">{guide.heading}</h2>
            <p className="mt-3 flex-1 text-[15px] leading-[24px] text-[var(--lp-body)]">{guide.description}</p>
            <div className="mt-6">
              <LpArrowLink href={guidePath(guide)}>Read the guide</LpArrowLink>
            </div>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
