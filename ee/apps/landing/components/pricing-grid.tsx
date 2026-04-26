import Link from "next/link";
import { Button } from "./ui/button";
import { DOWNLOAD_URL, GITHUB_URL } from "@/constants";
import LogoSymbolIcon from "@/icons/logos/logo-symbol";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary";

type Plan = {
  id: string;
  name: string;
  price: string;
  priceSuffix?: string;
  cadence?: string;
  badge?: string;
  description: string;
  ctaLabel: string;
  href: string;
  external?: boolean;
  highlight: { label: string };
  features: string[];
  variant: Variant;
};

type PricingGridProps = {
  callUrl: string;
  showHeader?: boolean;
};

const PricingCard = ({ plan }: { plan: Plan }) => {
  const isSecondary = plan.variant === "secondary";

  return (
    <article
      className={cn(
        "bg-background-muted p-2xl gap-xl flex h-full flex-col rounded-sm",
        isSecondary && "bg-primary text-white"
      )}
    >
      <div className="flex items-center justify-between">
        <LogoSymbolIcon
          className={cn("w-[4.4rem]", isSecondary && "text-white")}
        />
        {plan.badge ? (
          <span
            className={cn(
              "px-base-sm py-xs rounded-full font-sans text-sm leading-none font-medium",
              isSecondary ? "bg-white text-primary" : "bg-primary text-white"
            )}
          >
            {plan.badge}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col">
        <h2 className="mb-[1.2rem] font-sans text-lg font-medium tracking-tight">
          {plan.name}
        </h2>

        <p className="gap-sm mb-[3.2rem] flex items-baseline font-sans text-[4.8rem] font-bold tracking-tight leading-none">
          <span className="uppercase">{plan.price}</span>
          {plan.priceSuffix ? (
            <span className="font-sans text-[2.4rem] font-bold uppercase">
              {plan.priceSuffix}
            </span>
          ) : null}
          {plan.cadence ? (
            <span
              className={cn(
                "gap-xs relative z-0 flex items-baseline font-serif text-lg font-light tracking-normal",
                isSecondary ? "text-white/80" : "text-foreground/60"
              )}
            >
              {plan.cadence}
            </span>
          ) : null}
        </p>

        <div
          className={cn(
            "mb-[1.2rem] h-[1px] w-full",
            isSecondary ? "bg-white/20" : "bg-foreground/20"
          )}
        />

        <p className="text-base-sm mb-[3.2rem] font-sans font-medium">
          {plan.description}
        </p>

        <Button
          asChild
          className={cn(
            "mb-[3.2rem] h-[4.8rem] rounded-full",
            isSecondary && "bg-white text-primary hover:bg-white/90"
          )}
        >
          {plan.external ? (
            <a href={plan.href} target="_blank" rel="noreferrer">
              {plan.ctaLabel}
            </a>
          ) : (
            <Link href={plan.href}>{plan.ctaLabel}</Link>
          )}
        </Button>

        <div className="gap-sm flex flex-col">
          <h4 className="font-serif text-lg">What&apos;s Included:</h4>
          <ul className="text-base-sm font-sans font-medium">
            <li
              className={cn(
                "py-base gap-sm flex items-center border-b",
                isSecondary ? "border-b-white/20" : "border-b-foreground/20"
              )}
            >
              <span
                className={cn(
                  "px-base py-2xs rounded-full font-sans text-sm font-medium",
                  isSecondary
                    ? "bg-white text-primary"
                    : "bg-primary text-white"
                )}
              >
                {plan.highlight.label}
              </span>
            </li>
            {plan.features.map(feature => (
              <li
                key={feature}
                className={cn(
                  "py-base gap-sm flex items-center border-b",
                  isSecondary ? "border-b-white/20" : "border-b-foreground/20"
                )}
              >
                <p>{feature}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
};

export function PricingGrid({ callUrl, showHeader = false }: PricingGridProps) {
  const plans: Plan[] = [
    {
      id: "solo",
      name: "Solo",
      price: "$0",
      cadence: "free forever",
      description:
        "Open source desktop app. Your hardware, your keys, your workflows. MIT licensed.",
      ctaLabel: "Download free",
      href: DOWNLOAD_URL,
      highlight: { label: "MIT licensed" },
      features: [
        "All providers — Anthropic, OpenAI, Gemini, Mistral, Groq, Ollama",
        "Skill Manager + MCP servers",
        "macOS and Linux desktop",
        "Bring your own keys",
        "Community support on GitHub"
      ],
      variant: "primary"
    },
    {
      id: "team",
      name: "Team Starter",
      price: "$50",
      cadence: "per month",
      badge: "Most Popular",
      description:
        "Distribute workflows, skills, and provider keys to a small team — without anyone touching their own .env.",
      ctaLabel: "Start team plan",
      href: "https://app.openworklabs.com/checkout",
      external: true,
      highlight: { label: "5 seats included" },
      features: [
        "Skill Hub Manager for your org",
        "API access",
        "Distributed BYOK across the team",
        "Cloud workers (Den sandbox)",
        "Priority email support"
      ],
      variant: "secondary"
    },
    {
      id: "enterprise",
      name: "Enterprise",
      price: "Custom",
      description:
        "Self-hosted deployment, SSO, audit logs, LTS releases, and a dedicated rollout engineer.",
      ctaLabel: "Talk to us",
      href: callUrl,
      external: /^https?:\/\//.test(callUrl),
      highlight: { label: "Custom terms" },
      features: [
        "Self-hosted on your infra",
        "SSO / SAML and audit logs",
        "LTS releases and SLA",
        "Dedicated rollout engineer",
        "Custom commercial terms"
      ],
      variant: "primary"
    }
  ];

  return (
    <section className="gap-xl flex flex-col">
      {showHeader ? (
        <h2 className="h2 leading-[1.1] tracking-tight">Pricing</h2>
      ) : null}

      <div className="grid-12 gap-base">
        {plans.map(plan => (
          <div
            key={plan.id}
            className="col-span-12 sm:col-span-8 sm:col-start-3 md:col-span-4 md:col-start-auto"
          >
            <PricingCard plan={plan} />
          </div>
        ))}
      </div>

      <p className="text-foreground/60 text-center font-sans text-sm font-medium">
        Prices exclude taxes. Source on{" "}
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4"
        >
          GitHub
        </a>
        .
      </p>
    </section>
  );
}
