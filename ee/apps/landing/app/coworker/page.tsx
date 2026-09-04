import type { Metadata } from "next";

import "./coworker.css";
import { CoworkerAvatar, CoworkerMark } from "../../components/coworker-brand";
import { CoworkerVignette, TEAM } from "../../components/coworker-vignette";
import { StructuredData } from "../../components/structured-data";
import {
  CLOUD,
  COWORKER,
  GET_STARTED,
  HERO,
  MEMORY,
  NOTIFY,
  PLACEMENTS,
  POWERED_BY,
  ROLES,
  STEPS,
  TEAM as TEAM_COPY,
  WITH_OPENWORK
} from "../../lib/coworker-content";

const SITE_URL = "https://openworklabs.com";

/**
 * /coworker is Open Coworker's own front door: its own name, palette, type,
 * and shape (see coworker.css), marked "Powered by OpenWork" rather than
 * wrapped in the OpenWork site's chrome. Docs, pricing, Cloud, and Enterprise
 * stay the shared destinations the rest of the site sells.
 */

const NAV = [
  { href: "#team", label: "Your team" },
  { href: "#how", label: "How it works" },
  { href: "#memory", label: "Memory" },
  { href: "#responsibilities", label: "Assignments" },
  { href: "#cloud", label: "Cloud" },
] as const;

const SHARED_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" },
  { href: "/enterprise", label: "Enterprise" },
  { href: "/", label: "OpenWork" },
] as const;

export const metadata: Metadata = {
  title: "Open Coworker — A team that remembers. Powered by OpenWork",
  description:
    "Open Coworker gives you AI coworkers with names, roles, and memory you can read. Give them real work, come back to what happened. Free on your Mac, powered by OpenWork.",
  alternates: { canonical: "/coworker" },
  openGraph: {
    title: "Open Coworker — A team that remembers",
    description:
      "A small team of AI coworkers with a name, a role, readable memory, and responsibilities they own. Local-first on your Mac, powered by OpenWork.",
    url: `${SITE_URL}/coworker`,
    siteName: "Open Coworker",
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

/** OpenWork's own mark beside the words: the one place the platform is named on the page's chrome. */
function PoweredBy({ className = "", light = false }: { className?: string; light?: boolean }) {
  return (
    <a
      href="/"
      className={`inline-flex items-center gap-2 text-[12px] font-medium transition-colors ${light ? "text-[var(--cw-paper)]/70 hover:text-[var(--cw-paper)]" : "text-[var(--cw-ink-500)] hover:text-[var(--cw-ink)]"} ${className}`}
      data-testid="coworker-powered-by"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a 4 KB inline-served SVG; next/image adds nothing here. */}
      <img src="/openwork-mark.svg" alt="" aria-hidden="true" width={16} height={13} className={light ? "brightness-0 invert opacity-80" : "opacity-80"} />
      <span>{POWERED_BY}</span>
    </a>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="cw-eyebrow">{children}</p>;
}

function Display({ children, className = "", as: Tag = "h2" }: { children: React.ReactNode; className?: string; as?: "h1" | "h2" | "h3" }) {
  return <Tag className={`cw-display ${className}`}>{children}</Tag>;
}

function Mark({ children }: { children: React.ReactNode }) {
  return <span className="cw-mark">{children}</span>;
}

function Section({
  id,
  accent,
  eyebrow,
  title,
  lead,
  children,
}: {
  id: string;
  accent: "blue" | "violet" | "mint" | "rose";
  eyebrow: string;
  title: React.ReactNode;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`cw-accent-${accent} scroll-mt-24 py-20 md:py-28`}>
      <div className="mx-auto w-full max-w-[1080px] px-6 md:px-8">
        <div className="max-w-2xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <Display className="mt-4 text-[34px] md:text-[44px]">{title}</Display>
          {lead ? <p className="mt-5 text-[17px] leading-relaxed text-[var(--cw-ink-700)] md:text-[19px]">{lead}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}

function Points({ points, dot }: { points: ReadonlyArray<{ text: string } | string>; dot: string }) {
  return (
    <ul className="mt-5 space-y-2.5">
      {points.map((point) => {
        const text = typeof point === "string" ? point : point.text;
        return (
          <li key={text} className="flex gap-2.5 text-[15px] leading-relaxed text-[var(--cw-ink-700)]">
            <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot }} aria-hidden="true" />
            {text}
          </li>
        );
      })}
    </ul>
  );
}

export default function CoworkerPage() {
  return (
    <div className="cw relative min-h-screen overflow-x-hidden" data-testid="coworker-page">
      <StructuredData data={softwareSchema} />
      <div className="cw-backdrop" aria-hidden="true" />
      <div className="relative z-10">
        {/* Open Coworker's own header: its mark and name, the page's sections, and one quiet link back to the platform. */}
        <header className="sticky top-0 z-40">
          <div className="cw-nav">
            <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center justify-between gap-6 px-6 md:px-8">
              <a href="#top" className="flex items-center gap-2.5 text-[var(--cw-ink)]">
                <CoworkerMark size={30} label="Open Coworker" />
                <span className="text-[15px] font-bold tracking-[-0.02em]">{COWORKER.name}</span>
              </a>
              <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
                {NAV.map((item) => (
                  <a key={item.href} href={item.href} className="text-[13px] font-medium text-[var(--cw-ink-500)] transition-colors hover:text-[var(--cw-ink)]">
                    {item.label}
                  </a>
                ))}
              </nav>
              <div className="flex items-center gap-4">
                <PoweredBy className="hidden lg:inline-flex" />
                <a href={COWORKER.repository} className="hidden text-[13px] font-medium text-[var(--cw-ink-500)] transition-colors hover:text-[var(--cw-ink)] sm:block" rel="noreferrer">
                  GitHub
                </a>
                <a href={HERO.primary.href} className="cw-btn cw-btn--primary cw-btn--sm">
                  {HERO.primary.label}
                </a>
              </div>
            </div>
          </div>
        </header>

        <main id="top">
          {/* Hero */}
          <section className="cw-accent-blue relative overflow-hidden pt-16 md:pt-24">
            <div className="mx-auto w-full max-w-[1080px] px-6 md:px-8">
              <div className="max-w-3xl">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="cw-pill">Free · open source · macOS</span>
                  <PoweredBy className="lg:hidden" />
                </div>
                <Display as="h1" className="mt-6 text-[52px] sm:text-[72px] lg:text-[92px]">
                  A team that <Mark>remembers</Mark>.
                </Display>
                <p className="mt-7 max-w-2xl text-[18px] leading-relaxed text-[var(--cw-ink-700)] md:text-[20px]">{HERO.lead}</p>
                <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--cw-ink-500)]">{HERO.aside}</p>
                <div className="mt-9 flex flex-wrap items-center gap-3">
                  <a href={HERO.primary.href} className="cw-btn cw-btn--primary">{HERO.primary.label}</a>
                  <a href="#team" className="cw-btn cw-btn--ghost">Meet the team</a>
                </div>
                <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-3" aria-label="The team">
                  {ROLES.map((role) => {
                    const avatar = TEAM.find((member) => member.name === role.name) ?? TEAM[0]!;
                    return (
                      <li key={role.name} className="flex items-center gap-2.5">
                        <CoworkerAvatar name={role.name} color={avatar.color} glasses={avatar.glasses} size={36} />
                        <span className="text-[13px] leading-tight">
                          <span className="block font-semibold text-[var(--cw-ink)]">{role.name}</span>
                          <span className="block text-[var(--cw-ink-500)]">{role.role}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            <div className="mx-auto mt-16 w-full max-w-[1280px] px-6 md:mt-20 md:px-8" aria-label="Open Coworker, illustrated">
              <CoworkerVignette />
            </div>

            <div className="mx-auto mt-10 w-full max-w-[1080px] px-6 md:mt-12 md:px-8">
              <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[13px] text-[var(--cw-ink-500)]">
                {HERO.strip.map((phrase, index) => (
                  <span key={phrase} className="flex items-center gap-3">
                    {index > 0 ? <span aria-hidden="true" className="h-1 w-1 rounded-full bg-[var(--cw-ink-300)]" /> : null}
                    {phrase}
                  </span>
                ))}
              </p>
            </div>
          </section>

          {/* Team */}
          <Section id="team" accent="violet" eyebrow="Your team" title={<>Meet the <Mark>team</Mark>.</>} lead={TEAM_COPY.lead.text}>
            <div className="mt-12 grid gap-5 md:grid-cols-3">
              {ROLES.map((role) => {
                const avatar = TEAM.find((member) => member.name === role.name) ?? TEAM[0]!;
                return (
                  <div key={role.name} className="cw-bubble cw-bubble--tail flex h-full flex-col gap-5 p-6">
                    <CoworkerAvatar name={role.name} color={avatar.color} glasses={avatar.glasses} size={84} />
                    <div>
                      <Eyebrow>{role.role}</Eyebrow>
                      <Display as="h3" className="mt-1.5 text-[30px]">{role.name}</Display>
                      <p className="mt-2 text-[15px] leading-relaxed text-[var(--cw-ink-700)]">{role.line}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <ul className="mt-12 grid gap-x-10 gap-y-6 md:grid-cols-2">
              {TEAM_COPY.points.map((point) => (
                <li key={point.text} className="border-t border-[var(--cw-rule)] pt-4 text-[15px] leading-relaxed text-[var(--cw-ink-700)]">
                  {point.text}
                </li>
              ))}
            </ul>
          </Section>

          {/* How it works */}
          <Section id="how" accent="blue" eyebrow="How it works" title={<>Meet, talk, <Mark>hand over</Mark>.</>}>
            <ol className="mt-12 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="flex h-full flex-col gap-4 border-t-2 border-[var(--cw-ink)] pt-5">
                  <span className="cw-eyebrow">0{index + 1}</span>
                  <Display as="h3" className="text-[28px]">{step.title}</Display>
                  <p className="text-[15px] leading-relaxed text-[var(--cw-ink-700)]">{step.text}</p>
                </li>
              ))}
            </ol>
          </Section>

          {/* Memory */}
          <Section id="memory" accent="mint" eyebrow="Memory" title={<>Memory you can <Mark>read</Mark>.</>} lead={MEMORY.lead.text}>
            <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="cw-terminal overflow-hidden">
                <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
                  <span className="mono text-[11px] text-[#9aa3b2]">~/.config/openwork/coworkers/scout/</span>
                </div>
                <ul className="divide-y divide-white/[0.06]">
                  {MEMORY.files.map((file) => (
                    <li key={file.path} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                      <span className="mono text-[12.5px] text-[#f4f6fa]">{file.path}</span>
                      <span className="text-right text-[11.5px] text-[#9aa3b2]">{file.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="cw-bubble p-6">
                <Eyebrow>Why plain files</Eyebrow>
                <p className="mt-3 text-[15px] leading-relaxed text-[var(--cw-ink-700)]">
                  You can open any of them in a text editor, fix a wrong note, or hand a coworker's whole folder to a colleague. The coworker reads what is there on every turn; nothing about it is hidden in a database you cannot see.
                </p>
              </div>
            </div>
          </Section>

          {/* Assignments */}
          <Section id="responsibilities" accent="rose" eyebrow="Scheduled assignments" title={<>Recurring work, with the placement <Mark>said out loud</Mark>.</>} lead={PLACEMENTS.lead}>
            <div className="mt-12 grid gap-5 md:grid-cols-2">
              {PLACEMENTS.items.map((item) => (
                <div key={item.name} className="cw-bubble flex h-full flex-col p-7" data-testid="coworker-placement">
                  <div className="flex items-center justify-between gap-3">
                    <Display as="h3" className="text-[26px]">{item.name}</Display>
                    <span className="cw-pill cw-pill--ink">{item.badge}</span>
                  </div>
                  <Points points={item.points} dot={item.name === "OpenWork Cloud" ? "var(--cw-violet)" : "var(--cw-mint)"} />
                </div>
              ))}
            </div>
          </Section>

          {/* Powered by OpenWork: the one dark band on the page. */}
          <section id="with-openwork" className="cw-ink-band scroll-mt-24 py-20 md:py-28">
            <div className="mx-auto w-full max-w-[1080px] px-6 md:px-8">
              <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
                <div>
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element -- the platform's own mark, inverted for the dark band. */}
                    <img src="/openwork-mark.svg" alt="OpenWork" width={36} height={28} className="brightness-0 invert" />
                    <span className="cw-eyebrow !text-[var(--cw-paper)]/60">Platform</span>
                  </div>
                  <h2 className="cw-display mt-5 text-[34px] !text-[var(--cw-paper)] md:text-[44px]">
                    Powered by <Mark>OpenWork</Mark>.
                  </h2>
                  <p className="mt-5 text-[17px] leading-relaxed text-[var(--cw-paper)]/75">{WITH_OPENWORK.lead}</p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <a href="/" className="cw-btn cw-btn--sm !bg-[var(--cw-paper)] !text-[var(--cw-ink)] hover:!bg-white">About OpenWork</a>
                    <a href="/docs" className="cw-btn cw-btn--sm border border-[var(--cw-paper)]/25 text-[var(--cw-paper)] hover:bg-white/10">Docs</a>
                  </div>
                </div>
                <div className="overflow-hidden rounded-[22px] border border-[var(--cw-paper)]/15">
                  <div className="grid grid-cols-[1fr_1fr] gap-x-6 border-b border-[var(--cw-paper)]/15 bg-white/[0.04] px-6 py-4 text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--cw-paper)]/60 md:grid-cols-[180px_1fr_1fr]">
                    <span className="hidden md:block" />
                    <span>OpenWork Desktop</span>
                    <span className="text-[var(--cw-paper)]">Open Coworker</span>
                  </div>
                  {WITH_OPENWORK.rows.map((row) => (
                    <div key={row.ask} className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-[var(--cw-paper)]/10 px-6 py-5 last:border-b-0 md:grid-cols-[180px_1fr_1fr]" data-testid="coworker-compare-row">
                      <span className="text-[14px] font-semibold text-[var(--cw-paper)]">{row.ask}</span>
                      <span className="text-[14.5px] leading-[23px] text-[var(--cw-paper)]/65">{row.openwork}</span>
                      <span className="text-[14.5px] leading-[23px] text-[var(--cw-paper)]">{row.coworker}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Cloud */}
          <Section id="cloud" accent="violet" eyebrow="OpenWork Cloud" title={<>Free on your Mac. <Mark>OpenWork Cloud</Mark> when work must keep going.</>} lead={CLOUD.lead}>
            <div className="mt-12 grid gap-5 lg:grid-cols-2">
              <div className="cw-bubble flex h-full flex-col p-7">
                <div className="flex items-center justify-between gap-3">
                  <Display as="h3" className="text-[26px]">{CLOUD.free.name}</Display>
                  <span className="cw-pill cw-pill--mint">{CLOUD.free.badge}</span>
                </div>
                <Points points={CLOUD.free.points} dot="var(--cw-mint)" />
                <div className="mt-auto pt-7">
                  <a href={CLOUD.free.cta.href} className="cw-btn cw-btn--ghost">{CLOUD.free.cta.label}</a>
                </div>
              </div>
              <div className="cw-bubble flex h-full flex-col p-7 ring-2 ring-[var(--cw-violet)]/40">
                <div className="flex items-center justify-between gap-3">
                  <Display as="h3" className="text-[26px]">{CLOUD.cloud.name}</Display>
                  <span className="cw-pill">{CLOUD.cloud.badge}</span>
                </div>
                <p className="mt-2 text-[13px] text-[var(--cw-ink-500)]">{CLOUD.cloud.price.text}</p>
                <Points points={CLOUD.cloud.points} dot="var(--cw-violet)" />
                <div className="mt-auto flex flex-wrap items-center gap-3 pt-7">
                  <a href={CLOUD.cloud.cta.href} className="cw-btn cw-btn--primary" rel="noreferrer">{CLOUD.cloud.cta.label}</a>
                  <a href={CLOUD.cloud.secondary.href} className="text-[13px] font-medium text-[var(--cw-ink-500)] transition-colors hover:text-[var(--cw-ink)]">
                    {CLOUD.cloud.secondary.label} →
                  </a>
                </div>
              </div>
            </div>
            <div className="mt-8 flex flex-col gap-4 border-t border-[var(--cw-rule)] pt-7">
              <p className="max-w-3xl text-[14.5px] leading-relaxed text-[var(--cw-ink-500)]" data-testid="coworker-direction">
                {CLOUD.direction.text}
              </p>
              <p className="text-[13.5px] text-[var(--cw-ink-500)]">
                {CLOUD.teams.text}{" "}
                <a href={CLOUD.teams.cta.href} className="font-semibold text-[var(--cw-ink)] underline decoration-[var(--cw-ink-300)] underline-offset-4 hover:decoration-[var(--cw-ink)]">
                  {CLOUD.teams.cta.label} →
                </a>
              </p>
            </div>
          </Section>

          {/* Get started */}
          <Section id="get-started" accent="mint" eyebrow="Get started" title={<>Run it from <Mark>source</Mark> today.</>} lead={GET_STARTED.lead.text}>
            <div className="mt-10 grid items-start gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
              <div className="cw-terminal overflow-hidden">
                <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
                  <span className="mono text-[11px] text-[#9aa3b2]">Terminal</span>
                </div>
                <ol className="space-y-1.5 px-4 py-4">
                  {GET_STARTED.commands.map((command) => (
                    <li key={command} className="mono flex gap-3 text-[13px] text-[#f4f6fa]">
                      <span aria-hidden="true" className="select-none text-[#64748b]">$</span>
                      <span>{command}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="cw-bubble p-6">
                <span className="cw-pill cw-pill--amber">{GET_STARTED.status}</span>
                <p className="mt-4 text-[15px] leading-relaxed text-[var(--cw-ink-700)]">
                  Signed builds are on the way. Until then, Open Coworker runs from the OpenWork repository in a few minutes — no account needed to start.
                </p>
                <div className="mt-5 flex flex-col gap-2 text-[14px]">
                  <a href={NOTIFY.releases.href} rel="noreferrer" className="font-medium text-[var(--cw-ink)] underline decoration-[var(--cw-rule)] underline-offset-4 hover:decoration-[var(--cw-ink)]">{NOTIFY.releases.label}</a>
                  <a href={NOTIFY.email.href} className="font-medium text-[var(--cw-ink)] underline decoration-[var(--cw-rule)] underline-offset-4 hover:decoration-[var(--cw-ink)]">{NOTIFY.email.label}</a>
                  <a href="/docs" className="font-medium text-[var(--cw-ink)] underline decoration-[var(--cw-rule)] underline-offset-4 hover:decoration-[var(--cw-ink)]">Read the docs</a>
                </div>
              </div>
            </div>
          </Section>

          {/* Footer: Open Coworker's own, with the platform named once more and the shared destinations. */}
          <footer className="border-t border-[var(--cw-rule)] py-12">
            <div className="mx-auto w-full max-w-[1080px] px-6 md:px-8">
              <div className="cw-bubble cw-bubble--tail p-6 md:p-8">
                <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
                  <div className="flex items-start gap-3">
                    <CoworkerMark size={32} label="Open Coworker" />
                    <div>
                      <p className="text-[15px] font-bold tracking-[-0.01em] text-[var(--cw-ink)]">{COWORKER.name}</p>
                      <p className="mt-1 max-w-md text-[13px] leading-relaxed text-[var(--cw-ink-500)]">
                        Free and open source. Docs, pricing, Cloud, and Enterprise are shared with the rest of OpenWork.
                      </p>
                      <PoweredBy className="mt-3" />
                    </div>
                  </div>
                  <nav aria-label="Footer" className="flex flex-wrap items-center gap-5 md:pt-1">
                    <a href={COWORKER.repository} rel="noreferrer" className="text-[13px] font-medium text-[var(--cw-ink-500)] transition-colors hover:text-[var(--cw-ink)]">GitHub</a>
                    {SHARED_LINKS.map((link) => (
                      <a key={link.href} href={link.href} className="text-[13px] font-medium text-[var(--cw-ink-500)] transition-colors hover:text-[var(--cw-ink)]">
                        {link.label}
                      </a>
                    ))}
                  </nav>
                </div>
              </div>
              <p className="mt-6 text-[12px] text-[var(--cw-ink-500)]">© {new Date().getFullYear()} Different AI</p>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
