import { LandingBackground } from "./landing-background";
import { DenHero } from "./den-hero";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
  getStartedHref: string;
  callHref: string;
};

export function LandingDen(props: Props) {
  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={props.stars}
            callUrl={props.callHref}
            downloadHref={props.downloadHref}
            active="den"
          />
        </div>

        <div className="mx-auto flex w-full max-w-6xl flex-col gap-14 px-6 pb-24 md:px-8 md:pb-28">
          <DenHero getStartedHref={props.getStartedHref} />

          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
