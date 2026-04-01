import { LandingBackground } from "../../components/landing-background";
import { PricingGrid } from "../../components/pricing-grid";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork — Pricing",
  description:
    "Free desktop app, cloud workers from $50/month, and enterprise licensing."
};

export default async function PricingPage() {
  const github = await getGithubData();
  const callUrl = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";
  const windowsCheckoutUrl =
    process.env.NEXT_PUBLIC_WINDOWS_CHECKOUT_URL || "/download#windows-support";

  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={github.stars}
            callUrl={callUrl}
            downloadHref={github.downloads.macos}
            active="pricing"
          />
        </div>

        <main className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 pb-24 md:gap-20 md:px-8 md:pb-28">
          <section className="max-w-4xl pt-6 md:pt-10">
            <h1 className="mb-6 text-4xl font-medium leading-[1.05] tracking-tight md:text-5xl lg:text-6xl">
              Pricing
            </h1>
          </section>

          <PricingGrid
            windowsCheckoutUrl={windowsCheckoutUrl}
            callUrl={callUrl}
            showHeader={false}
          />

          <SiteFooter />
        </main>
      </div>
    </div>
  );
}
