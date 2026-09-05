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
      name: "Free",
      price: "0",
      priceCurrency: "USD",
      url: "https://app.openworklabs.com?mode=sign-up",
      availability: "https://schema.org/InStock",
      description:
        "Free for up to 5 users. Open source desktop app with bring-your-own-keys; self-host the full platform."
    },
    {
      "@type": "Offer",
      name: "Team",
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
        "$10 per seat per month, up to 100 users. Usage analytics, Extension Marketplace, distributed keys, standard support included."
    },
    {
      "@type": "Offer",
      name: "Enterprise",
      price: "40",
      priceCurrency: "USD",
      url: "https://openworklabs.com/enterprise",
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: "40",
        priceCurrency: "USD",
        unitText: "user per month"
      },
      description:
        "$40 per user per month, cloud or self-hosted. SSO/SAML and SCIM, desktop policies, OpenWork Web, spend observability, standard SLA support. Volume pricing above 100 users."
    }
  ]
};

export const metadata = {
  title: "OpenWork Pricing — Free up to 5 users, $10 Team, $40 Enterprise",
  description:
    "OpenWork is free for up to 5 users. Team is $10 per seat per month up to 100 users. Enterprise is $40 per user per month with SSO, desktop policies, and spend observability — same price cloud or self-hosted, volume pricing above 100 users.",
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
