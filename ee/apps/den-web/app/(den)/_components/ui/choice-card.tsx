import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "./button";

export type DenChoiceCardProps = {
  icon: ReactNode;
  title: string;
  /** Short qualifier rendered under the title (e.g. "Your providers, your billing"). */
  subtitle?: string;
  /** Right-aligned slot in the header row (e.g. a "Recommended" badge). */
  badge?: ReactNode;
  description: string;
  /** Extra content between the description and the CTA (e.g. provider logos). */
  children?: ReactNode;
  href: string;
  ctaLabel: string;
  ctaVariant?: "primary" | "secondary";
  testId?: string;
};

/**
 * Large navigation card used on onboarding to present a single path forward
 * (e.g. OpenWork Models vs Bring your Own Keys).
 */
export function DenChoiceCard({
  icon,
  title,
  subtitle,
  badge,
  description,
  children,
  href,
  ctaLabel,
  ctaVariant = "primary",
  testId,
}: DenChoiceCardProps) {
  return (
    <div
      data-testid={testId}
      className="flex h-full flex-col gap-4 rounded-[18px] border border-gray-200 bg-white p-5"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border border-gray-100 bg-gray-50">
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-[-0.02em] text-gray-950">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-[13px] leading-4 text-gray-400">{subtitle}</p> : null}
        </div>
        {badge ? <div className="ml-auto shrink-0">{badge}</div> : null}
      </div>
      <p className="text-[13px] leading-[21px] text-gray-500">{description}</p>
      {children}
      <Link href={href} className={buttonVariants({ variant: ctaVariant, className: "mt-auto" })}>
        {ctaLabel}
      </Link>
    </div>
  );
}
