import { RoadmapPage } from "./roadmap-page";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

export function RoadmapPageShell({ stars }: { stars: string }) {
  return (
    <div
      data-testid="roadmap-page-shell"
      className="min-h-screen overflow-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]"
    >
      <SiteNav stars={stars} active="roadmap" />
      <main className="mx-auto w-full max-w-6xl px-6 md:px-8">
        <RoadmapPage />
        <SiteFooter />
      </main>
    </div>
  );
}
