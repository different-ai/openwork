import { CoworkerMark } from "@/ui/brand";
import { HERO, NAV, SITE, TRUTHS } from "~/content";
import { NowCardMock, TeamRail, ThreadMock } from "~/mocks/product-mocks";
import { ButtonLink, Container, Pill, ProductFrame, Reveal, SourceNote } from "~/ui/primitives";

export function Nav() {
  return (
    <header className="sticky top-0 z-40">
      <div className="glass-strong border-x-0 border-t-0">
        <Container className="flex h-16 items-center justify-between gap-6">
          <a href="#top" className="flex items-center gap-2.5 text-snow">
            <CoworkerMark size={30} label="Open Coworker" />
            <span className="text-sm font-semibold tracking-[-0.01em]">{SITE.name}</span>
          </a>
          <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} className="text-[13px] font-medium text-mist transition-colors hover:text-snow">
                {item.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <a href={SITE.repository} className="hidden text-[13px] font-medium text-mist transition-colors hover:text-snow sm:block" rel="noreferrer">
              GitHub
            </a>
            <ButtonLink href={HERO.primary.href} className="h-9 px-4 text-[13px]">
              Get early access
            </ButtonLink>
          </div>
        </Container>
      </div>
    </header>
  );
}

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-16 md:pt-24">
      <Container>
        <Reveal>
          <div className="max-w-3xl">
            <Pill tone="spark">{HERO.eyebrow}</Pill>
            <h1 className="mt-5 text-[42px] font-semibold leading-[1.02] tracking-[-0.045em] text-snow sm:text-[56px] lg:text-[68px]">
              {HERO.title}
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-mist md:text-lg">{HERO.lead}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href={HERO.primary.href}>{HERO.primary.label}</ButtonLink>
              <ButtonLink href={HERO.secondary.href} variant="ghost">
                {HERO.secondary.label}
              </ButtonLink>
              <span className="ml-1 text-[12px] text-mist/80">
                Open source · local-first · <span className="text-mist">Powered by OpenWork</span>
              </span>
            </div>
          </div>
        </Reveal>

      </Container>

      <Container wide className="mt-14 md:mt-16">
        <Reveal delay={120}>
          <ProductFrame title="Open Coworker — Scout">
            <div className="grid grid-cols-1 border-t border-white/[0.06] md:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[244px_minmax(0,1fr)_296px]">
              <aside className="hidden border-r border-white/[0.06] p-3 md:block">
                <p className="eyebrow mb-2 px-2 pt-1">Coworkers</p>
                <TeamRail selected="Scout" />
              </aside>
              <main className="min-w-0 p-5">
                <div className="mb-4 flex items-center gap-2.5 border-b border-white/[0.06] pb-3">
                  <span className="truncate text-sm font-semibold text-snow">Compare the three onboarding flows against ours</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-spark">
                    <span className="status-dot bg-spark pulse" /> Working
                  </span>
                </div>
                <ThreadMock />
              </main>
              <aside className="hidden border-l border-white/[0.06] p-3 xl:block">
                <p className="eyebrow mb-2 px-1 pt-1">Activity</p>
                <NowCardMock />
              </aside>
            </div>
          </ProductFrame>
        </Reveal>
      </Container>

      <Container className="mt-16 md:mt-24">
        <Reveal>
          <ul className="grid gap-4 md:grid-cols-3">
            {TRUTHS.map((truth, index) => (
              <li key={truth.source} className="card p-5">
                <p className="eyebrow">{["Local-first", "Native threads", "Honest placement"][index]}</p>
                <p className="mt-2 text-[13.5px] leading-relaxed text-snow/90">{truth.text}</p>
                <SourceNote source={truth.source} />
              </li>
            ))}
          </ul>
        </Reveal>
      </Container>
    </section>
  );
}
