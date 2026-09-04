import type { Metadata } from "next";

import { CoworkerAvatar, CoworkerMark } from "../../components/coworker-brand";
import { CoworkerVignette, TEAM } from "../../components/coworker-vignette";
import { LpCopyBar } from "../../components/lp-copy-bar";
import { LpCta } from "../../components/lp-cta";
import { LpArrowLink, LpSectionHeader, LpTonalCard } from "../../components/lp-primitives";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { StructuredData } from "../../components/structured-data";
import {
  AGENT,
  CLOUD,
  COWORKER,
  GET_STARTED,
  HERO,
  MEMORY,
  NOTIFY,
  PLACEMENTS,
  STEPS,
  TEAM as TEAM_COPY,
  WITH_OPENWORK,
  allClaims
} from "../../lib/coworker-content";
import { getGithubData } from "../../lib/github";

const SITE_URL = "https://openworklabs.com";
const CLOUD_SIGNUP_URL = "https://app.openworklabs.com";

export const metadata: Metadata = {
  title: "Open Coworker — AI coworkers who remember, built on OpenWork",
  description:
    "Open Coworker is the coworker layer of OpenWork: a small team of AI coworkers with a name, a role, readable memory, and responsibilities they own — local-first on your Mac, with OpenWork Cloud for work that must keep going.",
  alternates: { canonical: "/coworker" },
  openGraph: {
    title: "Open Coworker — AI coworkers who remember, built on OpenWork",
    description:
      "A small team of AI coworkers with a name, a role, readable memory, and responsibilities they own. Local-first on your Mac, built on OpenWork.",
    url: `${SITE_URL}/coworker`,
    images: ["/coworker/og.png"]
  },
  twitter: {
    card: "summary_large_image",
    images: ["/coworker/og.png"]
  }
};

const softwareSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Open Coworker",
  applicationCategory: "BusinessApplication",
  operatingSystem: "macOS",
  url: `${SITE_URL}/coworker`,
  isPartOf: { "@type": "SoftwareApplication", name: "OpenWork", url: SITE_URL },
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  license: "https://opensource.org/licenses/MIT",
  codeRepository: COWORKER.repository,
  publisher: { "@type": "Organization", name: "OpenWork", url: SITE_URL }
};

export default async function CoworkerPage() {
  const github = await getGithubData();
  const callHref = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";
  const agentPrompt = AGENT.promptTemplate(`${SITE_URL}/coworker/start.md`);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <StructuredData data={softwareSchema} />
      <div className="relative z-10">
        <SiteNav
          stars={github.stars}
          downloadHref={github.downloads.macos}
          callUrl={callHref}
          mobilePrimaryHref={CLOUD_SIGNUP_URL}
          mobilePrimaryLabel="Get started for free"
          active="coworker"
        />

        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          {/* Hero */}
          <section className="pt-16 md:pt-[88px]">
            <div className="flex flex-col justify-between gap-10 lg:flex-row lg:items-end">
              <div className="max-w-[660px]">
                <div className="mb-5 flex items-center gap-2.5 text-[15px] text-[var(--lp-muted)]">
                  <CoworkerMark size={26} label="Open Coworker" />
                  <span>{COWORKER.eyebrow}</span>
                </div>
                <h1 className="text-[46px] font-light leading-[51px] tracking-[-0.02em] md:text-[58px] md:leading-[62px]">
                  <span className="block">{HERO.title[0]}</span>
                  <span className="font-pixel block font-normal">{HERO.title[1]}</span>
                </h1>
              </div>
              <div className="max-w-[440px] pb-1">
                <p className="text-[16px] leading-[25px]">{HERO.lead}</p>
                <p className="mt-4 text-[14px] leading-[22px] text-[var(--lp-body)]">{HERO.aside}</p>
              </div>
            </div>
            <div className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
              <div className="flex flex-col gap-3 sm:flex-row">
                <a href={HERO.primary.href} className="lp-pill-primary">{HERO.primary.label}</a>
                <a href={HERO.secondary.href} className="lp-pill-secondary">{HERO.secondary.label}</a>
              </div>
              <div className="flex items-center gap-3 sm:ml-2">
                <span className="flex -space-x-1.5">
                  {TEAM.map((member) => (
                    <span key={member.name} className="rounded-full ring-2 ring-[var(--lp-page)]">
                      <CoworkerAvatar name={member.name} color={member.color} glasses={member.glasses} size={30} />
                    </span>
                  ))}
                </span>
                <span className="text-[13.5px] text-[var(--lp-body)]">
                  {TEAM.map((member) => member.name).join(", ")} — a researcher, a writer, an operator. Each one a folder on your Mac.
                </span>
              </div>
            </div>
          </section>

          <section className="mt-14 md:mt-16" aria-label="Open Coworker, illustrated">
            <CoworkerVignette />
            <p className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[13.5px] text-[var(--lp-body)]">
              {HERO.strip.map((phrase, index) => (
                <span key={phrase} className="flex items-center gap-3">
                  {index > 0 ? <span aria-hidden="true" className="h-1 w-1 rounded-full bg-[var(--lp-faint)]" /> : null}
                  {phrase}
                </span>
              ))}
            </p>
          </section>

          {/* With OpenWork */}
          <section id="with-openwork" className="mt-24 scroll-mt-24 md:mt-32">
            <LpSectionHeader label="With OpenWork" heading={WITH_OPENWORK.title} headingLines={["Same platform.", "A different front door."]} />
            <p className="mt-6 max-w-[720px] text-[16px] leading-[25px] text-[var(--lp-body)]">{WITH_OPENWORK.lead}</p>
            <div className="mt-10 overflow-hidden rounded-[24px] border border-[var(--lp-border)]">
              <div className="grid grid-cols-[1fr_1fr] gap-x-6 border-b border-[var(--lp-border)] bg-[var(--lp-tonal)] px-6 py-4 text-[13px] font-medium text-[var(--lp-muted)] md:grid-cols-[200px_1fr_1fr]">
                <span className="hidden md:block" />
                <span>OpenWork Desktop</span>
                <span className="text-[var(--lp-ink)]">Open Coworker</span>
              </div>
              {WITH_OPENWORK.rows.map((row) => (
                <div key={row.ask} className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-[var(--lp-border)] px-6 py-5 last:border-b-0 md:grid-cols-[200px_1fr_1fr]" data-testid="coworker-compare-row">
                  <span className="text-[14px] font-medium text-[var(--lp-ink)]">{row.ask}</span>
                  <span className="text-[14.5px] leading-[23px] text-[var(--lp-body)]">{row.openwork}</span>
                  <span className="text-[14.5px] leading-[23px] text-[var(--lp-ink)]">{row.coworker}</span>
                </div>
              ))}
            </div>
          </section>

          {/* How it works */}
          <section id="how" className="mt-24 scroll-mt-24 md:mt-32">
            <LpSectionHeader label="How it works" heading="Meet, talk, hand over." />
            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <LpTonalCard key={step.title} className="p-7">
                  <div className="mono text-[13px] text-[var(--lp-muted)]">0{index + 1}</div>
                  <h3 className="mt-3 text-[22px] font-light leading-[28px] tracking-[-0.01em]">{step.title}</h3>
                  <p className="mt-3 text-[14.5px] leading-[23px] text-[var(--lp-body)]">{step.text}</p>
                </LpTonalCard>
              ))}
            </div>
          </section>

          {/* Memory + team */}
          <section id="memory" className="mt-24 scroll-mt-24 md:mt-32">
            <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-16">
              <div>
                <LpSectionHeader label="Memory" heading={MEMORY.title} size="small" />
                <p className="mt-6 text-[15.5px] leading-[25px] text-[var(--lp-body)]">{MEMORY.lead.text}</p>
                <div className="mt-8 rounded-[16px] bg-[var(--lp-terminal)] px-5 py-5">
                  <div className="mono text-[12px] text-[#94a3b8]">~/.config/openwork/coworkers/scout/</div>
                  <ul className="mt-3 space-y-2">
                    {MEMORY.files.map((file) => (
                      <li key={file.path} className="flex items-baseline justify-between gap-4 text-[13px]">
                        <span className="mono text-[#e2e8f0]">{file.path}</span>
                        <span className="text-right text-[#94a3b8]">{file.note}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div>
                <LpSectionHeader label="Team" heading={TEAM_COPY.title} size="small" />
                <p className="mt-6 text-[15.5px] leading-[25px] text-[var(--lp-body)]">{TEAM_COPY.lead.text}</p>
                <ul className="mt-8 space-y-4">
                  {TEAM_COPY.points.map((point) => (
                    <li key={point.text} className="flex gap-3 text-[14.5px] leading-[23px] text-[var(--lp-body)]">
                      <span aria-hidden="true" className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lp-ink)]" />
                      <span>{point.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {/* Placements */}
          <section id="responsibilities" className="mt-24 scroll-mt-24 md:mt-32">
            <LpSectionHeader label="Scheduled assignments" heading={PLACEMENTS.title} headingLines={["Recurring work,", "with the placement said out loud."]} />
            <p className="mt-6 max-w-[640px] text-[16px] leading-[25px] text-[var(--lp-body)]">{PLACEMENTS.lead}</p>
            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
              {PLACEMENTS.items.map((item) => (
                <div key={item.name} className="rounded-[24px] border border-[var(--lp-border)] p-7" data-testid="coworker-placement">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-[22px] font-light leading-[28px] tracking-[-0.01em]">{item.name}</h3>
                    <span className="rounded-full bg-[var(--lp-tonal)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--lp-muted)]">{item.badge}</span>
                  </div>
                  <ul className="mt-5 space-y-3">
                    {item.points.map((point) => (
                      <li key={point} className="flex gap-3 text-[14.5px] leading-[23px] text-[var(--lp-body)]">
                        <span aria-hidden="true" className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lp-ink)]" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          {/* Cloud */}
          <section id="cloud" className="mt-24 scroll-mt-24 md:mt-32">
            <LpSectionHeader label="OpenWork Cloud" heading={CLOUD.title} headingLines={["Free on your Mac.", "OpenWork Cloud when work must keep going."]} />
            <p className="mt-6 max-w-[720px] text-[16px] leading-[25px] text-[var(--lp-body)]">{CLOUD.lead}</p>
            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="rounded-[24px] border border-[var(--lp-border)] p-7">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[22px] font-light leading-[28px] tracking-[-0.01em]">{CLOUD.free.name}</h3>
                  <span className="rounded-full bg-[var(--lp-tonal)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--lp-muted)]">{CLOUD.free.badge}</span>
                </div>
                <ul className="mt-5 space-y-3">
                  {CLOUD.free.points.map((point) => (
                    <li key={point.text} className="flex gap-3 text-[14.5px] leading-[23px] text-[var(--lp-body)]">
                      <span aria-hidden="true" className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lp-ink)]" />
                      <span>{point.text}</span>
                    </li>
                  ))}
                </ul>
                <a href={CLOUD.free.cta.href} className="lp-pill-secondary lp-pill-sm mt-7">{CLOUD.free.cta.label}</a>
              </div>
              <LpTonalCard className="p-7">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[22px] font-light leading-[28px] tracking-[-0.01em]">{CLOUD.cloud.name}</h3>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11.5px] font-medium text-[var(--lp-blue)]">{CLOUD.cloud.badge}</span>
                </div>
                <p className="mt-2 text-[13.5px] text-[var(--lp-muted)]">{CLOUD.cloud.price.text}</p>
                <ul className="mt-5 space-y-3">
                  {CLOUD.cloud.points.map((point) => (
                    <li key={point.text} className="flex gap-3 text-[14.5px] leading-[23px] text-[var(--lp-body)]">
                      <span aria-hidden="true" className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--lp-ink)]" />
                      <span>{point.text}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-7 flex flex-wrap gap-3">
                  <a href={CLOUD.cloud.cta.href} className="lp-pill-primary lp-pill-sm">{CLOUD.cloud.cta.label}</a>
                  <a href={CLOUD.cloud.secondary.href} className="lp-pill-secondary lp-pill-sm">{CLOUD.cloud.secondary.label}</a>
                </div>
              </LpTonalCard>
            </div>
            <p className="mt-8 max-w-[720px] text-[13.5px] leading-[22px] text-[var(--lp-muted)]" data-testid="coworker-direction">
              <span className="font-medium text-[var(--lp-body)]">Where this is going. </span>
              {CLOUD.direction.text}
            </p>
            <p className="mt-3 text-[14px] text-[var(--lp-body)]">
              {CLOUD.teams.text} <LpArrowLink href={CLOUD.teams.cta.href}>{CLOUD.teams.cta.label}</LpArrowLink>
            </p>
          </section>

          {/* Get started */}
          <section id="get-started" className="mt-24 scroll-mt-24 md:mt-32">
            <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1fr] lg:gap-16">
              <div>
                <LpSectionHeader label="Get started" heading={GET_STARTED.title} size="small" />
                <p className="mt-6 text-[15.5px] leading-[25px] text-[var(--lp-body)]">{GET_STARTED.lead.text}</p>
                <p className="mt-4 text-[13px] text-[var(--lp-muted)]">{GET_STARTED.status}</p>
                <div className="mt-6 rounded-[12px] bg-[var(--lp-terminal)] px-5 py-[18px]">
                  <ol className="space-y-1.5">
                    {GET_STARTED.commands.map((command) => (
                      <li key={command} className="mono flex gap-3 text-[13.5px] text-[#e2e8f0]">
                        <span aria-hidden="true" className="select-none text-[#64748b]">$</span>
                        <span>{command}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-[14px]">
                  <LpArrowLink href={NOTIFY.releases.href}>{NOTIFY.releases.label}</LpArrowLink>
                  <LpArrowLink href={NOTIFY.email.href}>{NOTIFY.email.label}</LpArrowLink>
                  <LpArrowLink href={COWORKER.app}>Read the app's README</LpArrowLink>
                </div>
              </div>
              <div>
                <LpSectionHeader label="For your agent" heading={AGENT.title} size="small" />
                <p className="mt-6 text-[15.5px] leading-[25px] text-[var(--lp-body)]">{AGENT.text}</p>
                <div className="mt-6">
                  <LpCopyBar value={agentPrompt} />
                </div>
                <ul className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-[14px] text-[var(--lp-body)]">
                  {AGENT.links.map((link) => (
                    <li key={link.href}>
                      <a href={link.href} className="mono text-[var(--lp-ink)] underline decoration-[var(--lp-border)] underline-offset-4 hover:decoration-[var(--lp-ink)]">{link.label}</a>
                      <span className="text-[var(--lp-muted)]"> · {link.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          <div className="mt-24 md:mt-32">
            <LpCta
              heading="One platform. Pick how you like to work."
              sub="OpenWork Desktop when you want to see the work. Open Coworker when you want a team that remembers. OpenWork Cloud and Connect underneath both."
              primary={{ label: "Get OpenWork Cloud free", href: CLOUD_SIGNUP_URL }}
              secondary={{ label: "Download OpenWork Desktop", href: github.downloads.macos || "/download" }}
              trust="Open source · First 5 seats free · Bring your own model"
            />
          </div>

          {/* Where each claim is true */}
          <details className="mt-16 text-[13px] text-[var(--lp-muted)]" data-testid="coworker-claims">
            <summary className="cursor-pointer select-none">Where each claim on this page is true</summary>
            <ul className="mt-3 space-y-2">
              {allClaims().map((claim) => (
                <li key={claim.text} className="grid gap-1 md:grid-cols-[1fr_auto]">
                  <span className="text-[var(--lp-body)]">{claim.planned ? "Direction — " : ""}{claim.text}</span>
                  <span className="mono text-[12px] text-[var(--lp-faint)] md:text-right">{claim.source}</span>
                </li>
              ))}
            </ul>
          </details>

          <SiteFooter />
        </main>
      </div>
    </div>
  );
}
