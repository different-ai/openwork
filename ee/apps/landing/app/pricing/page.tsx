import { LandingBackground } from "../../components/landing-background";
import { PricingGrid } from "../../components/pricing-grid";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { StructuredData } from "../../components/structured-data";
import { getGithubData } from "../../lib/github";
import { baseOpenGraph } from "../../lib/seo";

const pricingSchema = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "OpenWork",
  description:
    "OpenWork is an open source Claude Cowork alternative — a desktop app for teams to use 50+ LLMs, bring their own keys, and share reusable agent setups with guardrails.",
  brand: { "@type": "Brand", name: "OpenWork" },
  offers: [
    {
      "@type": "Offer",
      name: "Solo",
      price: "0",
      priceCurrency: "USD",
      url: "https://app.openworklabs.com?mode=sign-up",
      availability: "https://schema.org/InStock",
      description: "Free forever. Open source desktop app with bring-your-own-keys."
    },
    {
      "@type": "Offer",
      name: "Team Starter",
      price: "10",
      priceCurrency: "USD",
      url: "https://app.openworklabs.com/dashboard/billing",
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: "10",
        priceCurrency: "USD",
        unitText: "seat per month"
      },
      description:
        "First 5 seats free, then $10 per seat per month. API access, Extension Marketplace, distributed keys."
    },
    {
      "@type": "Offer",
      name: "Enterprise",
      url: "https://openworklabs.com/enterprise",
      description:
        "Custom pricing. SSO/SAML and SCIM, bring your own inference, desktop policies and version controls, managed deployment, custom skill development, MCP consulting, and custom commercial terms."
    }
  ]
};

export const metadata = {
  title: "OpenWork Pricing — Free desktop, $10/seat teams, enterprise",
  description:
    "OpenWork is free forever for solo use with bring-your-own-keys. Teams get their first 5 seats free, then $10 per seat per month, plus custom enterprise plans with SSO and bring-your-own inference.",
  alternates: {
    canonical: "/pricing"
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/pricing"
  }
};

export default async function PricingPage() {
  const github = await getGithubData();
  const callUrl = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";

  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <StructuredData data={pricingSchema} />
      <LandingBackground fadeOnScroll={false} />

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
              OpenWork pricing — free, team, and enterprise
            </h1>
          </section>

          <PricingGrid
            callUrl={callUrl}
            showHeader={false}
          />

          <SiteFooter />
        </main>
      </div>
    </div>
  );
}
