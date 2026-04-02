"use client";

import { ArrowUpRight, Cloud, Download, Monitor, Shield } from "lucide-react";
import { ResponsiveGrain } from "./responsive-grain";

type PricingGridProps = {
  windowsCheckoutUrl: string;
  callUrl: string;
  showHeader?: boolean;
};

type PricingCard = {
  id: string;
  title: string;
  price: string;
  priceSub: string;
  ctaLabel: string;
  href: string;
  external?: boolean;
  features: Array<{ text: string; icon: typeof Download }>;
  footer: string;
  gradientColors: string[];
  gradientBack: string;
  gradientShape: "corners" | "wave" | "dots" | "truchet" | "ripple" | "blob" | "sphere";
  isCustomPricing?: boolean;
};

function PricingCardView({ card }: { card: PricingCard }) {
  return (
    <div className="group relative flex h-full flex-col">
      <div className="relative mb-6 flex-shrink-0 overflow-hidden rounded-[20px] bg-[#F4F4F4] p-5 text-gray-900 transition-colors duration-300 group-hover:text-white">
        <div className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          <ResponsiveGrain
            colors={card.gradientColors}
            colorBack={card.gradientBack}
            softness={0.6}
            intensity={0.35}
            noise={0.06}
            shape={card.gradientShape}
            speed={0.4}
          />
          <div className="absolute inset-0 bg-black/10 mix-blend-overlay" />
        </div>

        <div className="relative z-10 flex min-h-[160px] flex-col justify-between">
          <div>
            <div className="mb-6 flex items-start justify-between">
              <h3 className="text-[17px] font-medium tracking-tight">{card.title}</h3>
            </div>

            {card.isCustomPricing ? (
              <div className="mb-2 mt-4 text-[16px] font-semibold">{card.price}</div>
            ) : (
              <div className="mt-4">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[28px] font-semibold leading-none tracking-tight">{card.price}</span>
                  <span className="text-[12px] font-medium text-gray-500 transition-colors duration-300 group-hover:text-white/80">
                    {card.priceSub}
                  </span>
                </div>
              </div>
            )}
          </div>

          <a
            href={card.href}
            {...(card.external ? { rel: "noreferrer", target: "_blank" as const } : {})}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-gray-950 py-2.5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-gray-900"
          >
            {card.ctaLabel}
            <ArrowUpRight size={14} />
          </a>
        </div>
      </div>

      <div className="flex-1 pr-4">
        <div className="flex flex-col">
          {card.features.map((feature, idx) => {
            const Icon = feature.icon;
            return (
              <div
                key={idx}
                className="flex items-start gap-3 border-b border-dotted border-gray-400/40 py-3 text-[13px] font-medium text-gray-700 last:border-0"
              >
                <Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-gray-500" strokeWidth={1.5} />
                <span className="leading-snug">{feature.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-auto pt-8">
        <div className="text-[14px] font-medium text-gray-800">{card.footer}</div>
      </div>
    </div>
  );
}

export function PricingGrid(props: PricingGridProps) {
  const cards: PricingCard[] = [
    {
      id: "solo",
      title: "Solo",
      price: "$0",
      priceSub: "open source",
      ctaLabel: "Download free",
      href: "/download",
      features: [
        { text: "Open source desktop app", icon: Download },
        { text: "macOS and Linux downloads", icon: Download },
        { text: "Bring your own keys", icon: Download },
      ],
      footer: "Free forever",
      gradientColors: ["#7C3AED", "#A855F7", "#6D28D9", "#4338CA"],
      gradientBack: "#1E1B4B",
      gradientShape: "wave",
    },
    {
      id: "windows-support",
      title: "Windows support",
      price: "$99",
      priceSub: "per year · 1 seat",
      ctaLabel: "Purchase Windows support",
      href: props.windowsCheckoutUrl,
      external: /^https?:\/\//.test(props.windowsCheckoutUrl),
      features: [
        { text: "1 Windows seat", icon: Monitor },
        { text: "Binary access", icon: Monitor },
        { text: "1 year of updates", icon: Monitor },
      ],
      footer: "Manual fulfillment in phase one",
      gradientColors: ["#7C3AED", "#E11D48", "#9333EA", "#1F2937"],
      gradientBack: "#111827",
      gradientShape: "corners",
    },
    {
      id: "cloud-teams",
      title: "Cloud teams",
      price: "$50",
      priceSub: "per month · 5 seats",
      ctaLabel: "Start cloud plan",
      href: "https://app.openworklabs.com/checkout",
      external: true,
      features: [
        { text: "5 seats included", icon: Cloud },
        { text: "0 workers included by default", icon: Cloud },
        { text: "$50 per additional worker", icon: Cloud },
      ],
      footer: "Base plan first, then add worker capacity as needed",
      gradientColors: ["#2563EB", "#0284C7", "#0EA5E9", "#0F172A"],
      gradientBack: "#0C1220",
      gradientShape: "ripple",
    },
    {
      id: "enterprise-license",
      title: "Enterprise",
      price: "Custom pricing",
      priceSub: "",
      isCustomPricing: true,
      ctaLabel: "Talk to us",
      href: props.callUrl,
      external: /^https?:\/\//.test(props.callUrl),
      features: [
        { text: "Includes Windows support", icon: Shield },
        { text: "Deployment guidance", icon: Shield },
        { text: "Custom commercial terms", icon: Shield },
      ],
      footer: "For org-wide rollout and custom terms",
      gradientColors: ["#F97316", "#E11D48", "#9333EA", "#4338CA"],
      gradientBack: "#111827",
      gradientShape: "corners",
    },
  ];

  return (
    <section className="grid gap-8">
      {props.showHeader !== false ? (
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-500">
              Pricing
            </div>
            <h2 className="text-[40px] font-medium leading-[1.1] tracking-tight text-gray-900 md:text-[46px]">
              Gray by default. Clear when you hover.
            </h2>
          </div>
          <p className="max-w-xl text-sm leading-7 text-gray-600 md:text-right md:text-base">
            Solo stays free forever. Windows is annual. Cloud starts at 5 seats, and workers are added separately. Enterprise starts with a conversation.
          </p>
        </div>
      ) : null}

      <div className="relative grid grid-cols-1 border-l border-t border-dotted border-gray-400/50 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <div key={card.id} className="flex h-full flex-col border-b border-r border-dotted border-gray-400/50 p-6">
            <PricingCardView card={card} />
          </div>
        ))}
      </div>

      <p className="text-center text-[12px] font-medium text-gray-500">
        Prices exclude taxes. Windows delivery is manual in phase one.
      </p>
    </section>
  );
}
