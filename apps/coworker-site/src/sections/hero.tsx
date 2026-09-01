import { CoworkerMark } from "@/ui/brand";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { HERO, NAV, SITE } from "~/content";
import { NowCardMock, TEAM, TeamRail, ThreadMock } from "~/mocks/product-mocks";
import { ButtonLink, Container, Pill, ProductFrame, Reveal } from "~/ui/primitives";

export function Nav() {
  return (
    <header className="sticky top-0 z-40">
      <div className="glass-strong border-x-0 border-t-0">
        <Container wide className="flex h-16 items-center justify-between gap-6">
          <a href="#top" className="flex items-center gap-2.5 text-snow">
            <CoworkerMark size={30} label="Open Coworker" />
            <span className="text-sm font-semibold tracking-[-0.01em]">{SITE.name}</span>
          </a>
          <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} className="text-[13px] font-medium text-mist transition-colors hover:text-snow">
                {item.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-4">
            <a href={SITE.repository} className="hidden text-[13px] font-medium text-mist transition-colors hover:text-snow sm:block" rel="noreferrer">
              GitHub
            </a>
            <ButtonLink href={HERO.primary.href} className="h-9 px-4 text-[13px]">
              {HERO.primary.label}
            </ButtonLink>
          </div>
        </Container>
      </div>
    </header>
  );
}

/** The three coworkers from the product frame, as a warm byline under the headline. */
function TeamByline() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-1">
        {TEAM.map((member) => (
          <span key={member.name}>
            <CoworkerAvatar animated color={member.color} glasses={member.glasses} name={member.name} size={34} working={member.state === "working"} />
          </span>
        ))}
      </div>
      <p className="text-[13px] text-mist">
        <span className="text-snow">{TEAM.map((member) => member.name).join(", ")}</span> — a research partner, a writer, and an operator. Each one a
        folder on your Mac.
      </p>
    </div>
  );
}

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-14 md:pt-20">
      <Container>
        <Reveal>
          <div className="max-w-3xl">
            <Pill tone="spark">{HERO.eyebrow}</Pill>
            <h1 className="mt-5 text-[42px] font-semibold leading-[1.02] tracking-[-0.045em] text-snow sm:text-[56px] lg:text-[66px]">
              {HERO.title}
            </h1>
            <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-mist md:text-lg">{HERO.lead}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href={HERO.primary.href}>{HERO.primary.label}</ButtonLink>
              <ButtonLink href={HERO.secondary.href} variant="ghost">
                {HERO.secondary.label}
              </ButtonLink>
            </div>
            <div className="mt-9">
              <TeamByline />
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

      <Container className="mt-10 md:mt-12">
        <Reveal>
          <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[13px] text-mist">
            {HERO.strip.map((phrase, index) => (
              <span key={phrase} className="flex items-center gap-3">
                {index > 0 ? <span aria-hidden="true" className="size-1 rounded-full bg-mist/40" /> : null}
                {phrase}
              </span>
            ))}
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
