"use client";

import { ArrowUpRight, Cloud, Download, Shield } from "lucide-react";
import { ResponsiveGrain } from "./responsive-grain";

type PricingGridProps = {
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
  footer?: string;
  gradientColors: string[];
  gradientBack: string;
  gradientShape: "corners" | "wave" | "dots" | "truchet" | "ripple" | "blob" | "sphere";
  isCustomPricing?: boolean;
};

function PricingCardView({ card }: { card: PricingCard }) {
  return (
    <div className="flex h-full flex-col relative group">
      {/* ── Header card ── */}
      <div className="relative p-5 rounded-[20px] overflow-hidden mb-6 flex-shrink-0 bg-[#F4F4F4] text-gray-900 group-hover:text-white transition-colors duration-300">
        {/* Shader layer — hidden by default, revealed on hover */}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
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

        <div className="relative z-10 flex flex-col h-full min-h-[160px] justify-between">
          <div>
            <div className="flex justify-between items-start mb-6">
              <h3 className="text-[17px] font-medium tracking-tight">{card.title}</h3>
            </div>

            {card.isCustomPricing ? (
              <div className="text-[16px] font-semibold mt-4 mb-2">{card.price}</div>
            ) : (
              <div className="mt-4">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[28px] font-semibold tracking-tight leading-none">{card.price}</span>
                  <span className="text-[12px] font-medium text-gray-500 group-hover:text-white/80 transition-colors duration-300">
                    {card.priceSub}
                  </span>
                </div>
              </div>
            )}
          </div>

          <a
            href={card.href}
            {...(card.external ? { rel: "noreferrer", target: "_blank" as const } : {})}
            className="w-full mt-6 py-2.5 rounded-full text-[13px] font-medium bg-gray-950 text-white hover:bg-gray-900 shadow-sm transition-colors flex items-center justify-center gap-2"
          >
            {card.ctaLabel}
            <ArrowUpRight size={14} />
          </a>
        </div>
      </div>

      {/* ── Features list ── */}
      <div className="flex-1 pr-4">
        <div className="flex flex-col">
          {card.features.map((feature, idx) => {
            const Icon = feature.icon;
            return (
              <div
                key={idx}
                className="flex items-start gap-3 py-3 border-b border-dotted border-gray-400/40 last:border-0 text-[13px] text-gray-700 font-medium"
              >
                <Icon className="w-[18px] h-[18px] text-gray-500 shrink-0 mt-0.5" strokeWidth={1.5} />
                <span className="leading-snug">{feature.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Footer ── */}
      {card.footer ? (
        <div className="mt-auto pt-8">
          <div className="text-[14px] font-medium text-gray-800">{card.footer}</div>
        </div>
      ) : null}
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
      id: "cloud-workers",
      title: "Team starter",
      price: "$50",
      priceSub: "per month",
      ctaLabel: "Start team plan",
      href: "https://app.openworklabs.com/checkout",
      external: true,
      features: [
        { text: "5 seats included", icon: Cloud },
        { text: "API access", icon: Cloud },
        { text: "Skill Hub Manager", icon: Cloud },
        { text: "Bring your own LLM keys, distributed to your team", icon: Cloud },
      ],
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
        { text: "Enterprise rollout support", icon: Shield },
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
          <h2 className="text-[40px] md:text-[46px] font-medium tracking-tight text-gray-900 leading-[1.1]">
            Pricing
          </h2>
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-3 relative border-l border-t border-dotted border-gray-400/50">
        {cards.map((card) => (
          <div key={card.id} className="p-6 border-r border-b border-dotted border-gray-400/50 flex flex-col h-full">
            <PricingCardView card={card} />
          </div>
        ))}
      </div>

      <p className="text-center text-[12px] font-medium text-gray-500">
        Prices exclude taxes.
      </p>
    </section>
  );
}
