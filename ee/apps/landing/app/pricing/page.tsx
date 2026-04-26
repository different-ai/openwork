import { PricingGrid } from "../../components/pricing-grid";
import { StructuredData } from "../../components/structured-data";
import FaqsSection from "../../components/ui/faqs-section";
import PageHeading from "../../components/ui/page-heading";
import { FAQS } from "../../constants/faqs";
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
      url: "https://openworklabs.com/download",
      availability: "https://schema.org/InStock",
      description: "Free forever. Open source desktop app with bring-your-own-keys."
    },
    {
      "@type": "Offer",
      name: "Team Starter",
      price: "50",
      priceCurrency: "USD",
      url: "https://app.openworklabs.com/checkout",
      availability: "https://schema.org/InStock",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: "50",
        priceCurrency: "USD",
        unitText: "MONTH"
      },
      description: "5 seats, API access, Skill Hub Manager, distributed keys."
    },
    {
      "@type": "Offer",
      name: "Enterprise",
      url: "https://openworklabs.com/enterprise",
      description:
        "Custom pricing. Enterprise rollout support, deployment guidance, and custom commercial terms."
    }
  ]
};

export const metadata = {
  title: "OpenWork Pricing — Free desktop, $50/mo cloud, enterprise",
  description:
    "OpenWork is free forever for solo use with bring-your-own-keys. Cloud workers from $50/month per seat, plus custom enterprise licensing with self-hosted deployment.",
  alternates: {
    canonical: "/pricing"
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/pricing"
  }
};

export default function PricingPage() {
  const callUrl = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";

  return (
    <main className="pricing-page flex flex-col gap-(--sections-gap) pt-(--page-pt)">
      <StructuredData data={pricingSchema} />

      <div className="grid-12 gap-y-[8rem] px-(--container-px)">
        <div className="col-span-12 sm:col-span-8 sm:col-start-3 md:col-span-8 md:col-start-3">
          <PageHeading
            eyebrow="Plans designed around how you ship agents"
            title="Choose your plan"
            description="Free forever for solo. Bring your team in for $50 a month. Self-host the whole thing on enterprise. No hidden fees, no per-token surprises — open source all the way down."
          />
        </div>
        <div className="col-span-12">
          <PricingGrid callUrl={callUrl} showHeader={false} />
        </div>
      </div>

      <FaqsSection faqs={FAQS} />
    </main>
  );
}
