import type { Metadata } from "next";
import { ArrowRight, ArrowDownToLine, BookOpen, FileText, Plug, Users } from "lucide-react";
import "@openwork/ui/coworker.css";
import "@openwork/ui/coworker-effort.css";
import "./coworker.css";
import { CoworkerAvatar, CoworkerMark } from "../../components/coworker-brand";
import { CoworkerVignette, CoworkerDemoShortcut } from "../../components/coworker-vignette";
import { TEAM } from "../../lib/coworker-demo";
import { CoworkerAction, CoworkerAnnouncementView } from "../../components/coworker-announcement-actions";
import { StructuredData } from "../../components/structured-data";
import { CoworkerWorkExamples } from "../../components/coworker-work-examples";
import { CoworkerFeatureLab } from "../../components/coworker-feature-lab";
import { BENEFITS, COLLABORATION, COWORKER, FAQ, GET_STARTED, HERO, MODELS, NOTIFY, OPENWORK, POWERED_BY, STEPS } from "../../lib/coworker-content";

const SITE_URL = "https://openworklabs.com";
const SHARED_LINKS = [{ href: "/docs", label: "Docs" }, { href: "/pricing", label: "Team pricing" }, { href: "/enterprise", label: "Enterprise" }, { href: "/", label: "OpenWork" }];

export const metadata: Metadata = {
  title: `Open Coworker — ${HERO.title}`,
  description: HERO.lead,
  alternates: { canonical: "/coworker" },
  openGraph: {
    title: `Open Coworker — ${HERO.title}`,
    description: HERO.lead,
    url: SITE_URL + "/coworker",
    siteName: "Open Coworker",
    images: ["/coworker/opengraph-image"],
  },
  twitter: { card: "summary_large_image", images: ["/coworker/opengraph-image"] },
};

function PoweredBy() {
  return <a href="/" className="inline-flex items-center gap-2 text-xs text-[var(--cw-muted)]" data-testid="coworker-powered-by">
    {/* eslint-disable-next-line @next/next/no-img-element -- a small brand SVG */}
    <img src="/openwork-mark.svg" alt="" aria-hidden="true" width={16} height={13} className="brightness-0 invert opacity-70" />
    <span>{POWERED_BY}</span>
  </a>;
}

export default function CoworkerPage() {
  return (
    <div className="cw relative min-h-screen overflow-x-hidden" data-testid="coworker-page">
      <CoworkerAnnouncementView />
      <StructuredData data={{
        "@context": "https://schema.org", "@type": "SoftwareApplication",
        name: COWORKER.name, description: HERO.lead, applicationCategory: "BusinessApplication",
        operatingSystem: "macOS", url: SITE_URL + COWORKER.path,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        license: "https://opensource.org/licenses/MIT", codeRepository: COWORKER.repository,
        publisher: { "@type": "Organization", name: "OpenWork", url: SITE_URL },
      }} />
      <div className="cw-backdrop" aria-hidden="true" />
      <div className="relative z-10">
        <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-white focus:p-3 focus:text-black">Skip to content</a>
        <main id="main-content">
          <section id="top" className="cw-hero px-5 pb-3 pt-9 text-center md:px-8 md:pt-10">
            <div className="mx-auto max-w-[1040px]">
              <div className="cw-hero-icon"><CoworkerMark size={64} /></div>
              <p className="cw-eyebrow">{HERO.eyebrow}</p>
              <h1 className="cw-display mx-auto mt-4 max-w-[960px] text-[44px] sm:text-[60px] lg:text-[72px]" data-testid="coworker-headline">{HERO.lines.map((line, index) => <span key={line} className={index === 0 ? "block" : "block cw-hero-accent"}>{index > 0 && " "}{line}</span>)}</h1>
              <p className="mx-auto mt-4 max-w-[620px] text-base leading-7 text-[var(--cw-secondary)] md:text-lg">{HERO.lead}</p>
              <div className="mt-7 flex flex-wrap justify-center gap-3">
                <CoworkerAction href={HERO.primary.href} action="download" placement="hero" className="cw-btn cw-btn--primary"><ArrowDownToLine size={16} aria-hidden="true" />{HERO.primary.label}</CoworkerAction>
                <CoworkerAction href={HERO.secondary.href} action="how_it_works" placement="hero" className="cw-btn cw-btn--ghost">{HERO.secondary.label}<span aria-hidden="true">↓</span></CoworkerAction>
              </div>
              <p className="mt-4 text-xs leading-5 text-[var(--cw-muted)]">macOS alpha available · Apple Silicon · Signed and notarized</p>
              <div className="mt-5 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] text-[var(--cw-muted)]">
                {HERO.strip.map((phrase) => <span key={phrase}>{phrase}</span>)}
              </div>
              <a href="#openwork" className="cw-connect-path" aria-label="See how OpenWork connects your tools and coworkers">
                <span><Plug size={16} aria-hidden="true" />Your apps</span><ArrowRight className="cw-connect-path-arrow" size={14} aria-hidden="true" />
                <span><BookOpen size={16} aria-hidden="true" />Shared skills</span><ArrowRight className="cw-connect-path-arrow" size={14} aria-hidden="true" />
                <span><Users size={16} aria-hidden="true" />Your coworkers</span><ArrowRight className="cw-connect-path-arrow" size={14} aria-hidden="true" />
                <span><FileText size={16} aria-hidden="true" />Useful work</span>
              </a>
            </div>
          </section>

          <section id="how" className="scroll-mt-6 px-5 pb-16 pt-10 md:px-8 md:pb-20">
            <div className="mx-auto max-w-[1040px]">
              <h2 className="mb-5 text-center text-sm font-normal text-[var(--cw-muted)]">Pick up the conversation.</h2>
              <figure aria-label="Interactive Open Coworker walkthrough">
                <CoworkerVignette />
                <figcaption id="coworker-demo-disclosure" className="mt-4 text-center text-[11px] text-[var(--cw-muted)]">Sample data and scripted replies. No sign-in needed. A look at the developing app; the alpha download may differ.</figcaption>
                <noscript><p className="mt-3 text-center text-sm text-[var(--cw-muted)]">Enable JavaScript to explore the interactive demo.</p></noscript>
              </figure>
            </div>
          </section>

          <section id="team" className="px-5 pb-16 md:px-8 md:pb-20">
            <div className="mx-auto max-w-[1040px]">
              <div className="cw-collaboration-story">
                <div><p className="cw-eyebrow">A shared conversation</p><h2>One brief.<br />More than one perspective.</h2><p>{COLLABORATION.text}</p><CoworkerDemoShortcut view="group">Try the team conversation</CoworkerDemoShortcut></div>
                <div className="cw-collaboration-example"><div className="flex items-center gap-3">{TEAM.map((person) => <CoworkerAvatar key={person.id} {...person} identity={"landing:" + person.id} motion="presentation" size={40} />)}<span className="text-xs text-[var(--cw-muted)]">+ you</span></div><p className="cw-collaboration-quote">“Scout, find the angle. Editor, make it clear. Ops, help us get it out the door.”</p><p>Different roles. One direction. You stay in the conversation.</p></div>
              </div>
              <div className="cw-custom-story"><div><p className="cw-eyebrow">Your team, your way</p><h2>Different coworkers.<br />A clear role for each.</h2></div><div><p>A growth partner to shape campaigns. A support partner to draft replies. A researcher to find the useful details. Add a coworker, give it responsibilities, and decide together what to take on first.</p><CoworkerDemoShortcut view="create">Make a coworker in the demo</CoworkerDemoShortcut></div></div>
              <ol className="mt-12 grid gap-8 md:grid-cols-3">
                {STEPS.map((step, index) => <li key={step.title} className="border-t border-[var(--cw-border)] pt-5">
                  <span className="cw-eyebrow">0{index + 1}</span>
                  <h3 className="mt-3 text-lg font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--cw-secondary)]">{step.text}</p>
                </li>)}
              </ol>
            </div>
          </section>

          <section className="px-5 pb-16 md:px-8 md:pb-24" aria-label="What your coworker helps with" data-testid="coworker-benefits">
            <div className="mx-auto grid max-w-[1040px] gap-5 md:grid-cols-3">
              {BENEFITS.map((benefit, index) => {
                const avatar = TEAM[index]!;
                return <article key={benefit.title} className="cw-card flex flex-col p-6">
                  <div className="flex items-center gap-3"><CoworkerAvatar name={benefit.name} identity={"landing:" + avatar.id} animated={false} motion="quiet" gaze={false} color={avatar.color} glasses={avatar.glasses} size={44} /><p className="text-sm font-semibold">{benefit.name}<span className="mt-0.5 block text-xs font-normal text-[var(--cw-muted)]">{benefit.role}</span></p></div>
                  <h2 className="mt-6 text-xl font-semibold leading-tight tracking-tight" data-testid={`coworker-benefit-${index}`}>{benefit.title}</h2>
                  <p className="mt-3 text-sm leading-6 text-[var(--cw-secondary)]">{benefit.text}</p>
                  <div className="cw-feature-example">
                    <div><span>{benefit.preview.label}</span><small>Example</small></div>
                    <p>{benefit.preview.title}</p>
                    <span className="cw-feature-example-detail">{benefit.preview.detail}</span>
                  </div>
                  <p className="mt-auto pt-5 text-sm leading-6 text-[var(--cw-muted)]">“{benefit.example}”</p>
                </article>;
              })}
            </div>
          </section>

          <section id="openwork" className="scroll-mt-24 px-5 pb-16 md:px-8 md:pb-24" aria-labelledby="coworker-openwork-title" data-testid="coworker-openwork">
            <div className="mx-auto max-w-[1040px]">
              <div className="grid gap-10 md:grid-cols-[1fr_1.15fr] md:gap-14">
                <div>
                  <p className="cw-eyebrow">{POWERED_BY}</p>
                  <h2 id="coworker-openwork-title" data-testid="coworker-openwork-title" className="cw-display mt-5 max-w-sm text-[34px] md:text-[40px]">{OPENWORK.title}</h2>
                  <p className="mt-5 text-sm leading-7 text-[var(--cw-secondary)]">{OPENWORK.lead.text}</p>
                  <a href={OPENWORK.cta.href} className="cw-btn cw-btn--ghost mt-7">{OPENWORK.cta.label}<span aria-hidden="true">↗</span></a>
                </div>
                <div>
                  <dl className="divide-y divide-[var(--cw-border)]">
                    {OPENWORK.items.map((item, index) => <div key={item.title} className="grid grid-cols-[1.25rem_1fr] gap-x-4 py-5 first:pt-0">
                      <dt className="col-span-2 flex gap-4 text-base font-medium"><span aria-hidden="true" className="w-5 shrink-0 pt-1 text-xs tabular-nums text-[var(--cw-muted)]">0{index + 1}</span>{item.title}</dt>
                      <dd className="col-start-2 mt-2 text-sm leading-7 text-[var(--cw-secondary)]">{item.text}</dd>
                    </div>)}
                  </dl>
                  <p data-testid="coworker-openwork-note" className="border-t border-[var(--cw-border)] pt-4 text-xs leading-6 text-[var(--cw-muted)]">{OPENWORK.note}</p>
                </div>
              </div>
              <CoworkerWorkExamples />
            </div>
          </section>

          <CoworkerFeatureLab />

          <section id="models" className="cw-models-band scroll-mt-16 px-5 py-16 md:px-8 md:py-20" data-testid="coworker-models">
            <div className="mx-auto grid max-w-[1040px] gap-10 md:grid-cols-[3fr_2fr] md:items-center">
              <div>
                <p className="cw-eyebrow !text-white/60">OpenWork Models</p>
                <h2 className="mt-4 max-w-lg text-[34px] font-semibold leading-[1.08] tracking-[-0.04em] md:text-[44px]">{MODELS.title}</h2>
                <p className="mt-5 max-w-lg text-base leading-7 text-white/75">{MODELS.lead.text}</p>
              </div>
              <div className="rounded-2xl border border-white/20 bg-white/[0.04] p-6 md:p-7">
                <p className="text-base leading-7 text-white/85">{MODELS.detail}</p>
                <CoworkerAction href={MODELS.cta.href} action="models" placement="models" className="cw-btn cw-btn--primary mt-6 w-full">{MODELS.cta.label}<span aria-hidden="true">↗</span></CoworkerAction>
                <CoworkerAction href={MODELS.member.href} action="member_sign_in" placement="models" className="mt-4 block text-center text-sm text-white/75 underline underline-offset-4 hover:text-white">{MODELS.member.label}</CoworkerAction>
                <p className="mt-5 border-t border-white/15 pt-4 text-xs leading-5 text-white/60">{MODELS.note}</p>
              </div>
            </div>
          </section>

          <section className="px-5 py-16 md:px-8 md:py-20" aria-label="Questions about Open Coworker">
            <div className="mx-auto max-w-[720px]">
              <h2 className="cw-display mb-8 text-3xl">A few things to know.</h2>
              <div className="divide-y divide-[var(--cw-border)] border-y border-[var(--cw-border)]">
                {FAQ.map((item, index) => <details key={item.question} className="group py-5">
                  <summary data-testid={`coworker-question-${index}`} className="cursor-pointer text-base font-medium">{item.question}</summary>
                  <p className="mt-3 pr-4 text-sm leading-7 text-[var(--cw-secondary)]">{item.text}</p>
                </details>)}
              </div>
            </div>
          </section>

          <section id="get-started" className="scroll-mt-24 px-5 pb-20 text-center md:px-8 md:pb-24">
            <div className="mx-auto max-w-[720px]">
               <CoworkerMark size={76} />
              <h2 className="cw-display mt-6 text-[38px] md:text-[52px]">{GET_STARTED.title}</h2>
              <p className="mx-auto mt-5 max-w-lg text-base leading-7 text-[var(--cw-secondary)]">{GET_STARTED.lead}</p>
               <CoworkerAction href={COWORKER.download} action="download" placement="footer" className="cw-btn cw-btn--primary mt-7"><ArrowDownToLine size={16} aria-hidden="true" />Download alpha</CoworkerAction>
              <p className="mt-5 text-xs text-[var(--cw-muted)]">{GET_STARTED.status}</p>
               <div className="mt-5 flex flex-wrap justify-center gap-5 text-sm">
                <CoworkerAction href={COWORKER.app} action="source" placement="footer" className="underline decoration-[var(--cw-border)] underline-offset-4">Build from source</CoworkerAction>
                <CoworkerAction href={NOTIFY.releases.href} action="releases" placement="footer" className="underline decoration-[var(--cw-border)] underline-offset-4">{NOTIFY.releases.label}</CoworkerAction>
               </div>
               <p className="mt-6 text-xs text-[var(--cw-muted)]"><CoworkerAction href={NOTIFY.email.href} action="email_early_access" placement="footer" className="underline underline-offset-4">{NOTIFY.email.label}</CoworkerAction> · Opens your email app</p>
            </div>
          </section>
        </main>

        <footer className="border-t border-[var(--cw-border)] px-5 py-8 md:px-8">
          <div className="mx-auto flex max-w-[1040px] flex-col justify-between gap-6 md:flex-row md:items-center">
            <PoweredBy />
            <nav aria-label="Footer" className="flex flex-wrap gap-5 text-xs text-[var(--cw-muted)]">
              {SHARED_LINKS.map((link) => <a key={link.href} href={link.href} className="hover:text-[var(--cw-text)]">{link.label}</a>)}
              <a href={COWORKER.repository}>GitHub</a>
            </nav>
            <p className="text-xs text-[var(--cw-muted)]">© {new Date().getFullYear()} Different AI</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
