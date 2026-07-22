import { OpenWorkRoadmap } from "@openwork/ui/react";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

export function RoadmapPageShell({ stars }: { stars: string }) {
  return (
    <div
      data-testid="roadmap-page-shell"
      className="min-h-screen overflow-hidden bg-[#f6f9fc] text-[#011627]"
    >
      <SiteNav stars={stars} active="roadmap" />
      <main className="mx-auto w-full max-w-6xl px-6 md:px-8">
        <OpenWorkRoadmap />
        <SiteFooter />
      </main>
    </div>
  );
}
