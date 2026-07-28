import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "./button";

export type DenChoiceCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
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
  description,
  href,
  ctaLabel,
  ctaVariant = "primary",
  testId,
}: DenChoiceCardProps) {
  return (
    <div
      data-testid={testId}
      className="flex h-full flex-col gap-5 rounded-[28px] border border-gray-200 bg-white p-6"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-gray-100 bg-gray-50">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-[16px] font-medium tracking-[-0.02em] text-gray-950">{title}</h3>
        <p className="mt-2 text-[13px] leading-6 text-gray-500">{description}</p>
      </div>
      <Link href={href} className={buttonVariants({ variant: ctaVariant })}>
        {ctaLabel}
      </Link>
    </div>
  );
}
