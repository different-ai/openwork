import {
  ArrowRightLeft,
  Cloud,
  Cpu,
  KeyRound,
  Library,
  Monitor,
  Split,
  Users,
  type LucideIcon
} from "lucide-react";
import type { ReactNode } from "react";

import type { CompareCard, CompareIcon } from "../lib/compare";
import { LpArrowLink } from "./lp-primitives";

const icons: Record<CompareIcon, LucideIcon> = {
  cpu: Cpu,
  key: KeyRound,
  monitor: Monitor,
  users: Users,
  cloud: Cloud,
  route: Split,
  library: Library,
  migrate: ArrowRightLeft
};

export function CompareCards({ cards }: { cards: CompareCard[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = icons[card.icon];
        return (
          <li key={card.title} className="flex flex-col rounded-[20px] bg-[var(--lp-tonal)] p-6">
            <Icon aria-hidden="true" strokeWidth={1.5} className="h-5 w-5 text-[var(--lp-ink)]" />
            <h3 className="mt-8 flex-1 text-[17px] font-medium leading-[24px] tracking-[-0.01em] [text-wrap:balance]">
              {card.title}
            </h3>
            <div className="mt-6">
              <LpArrowLink href={card.link.href}>{card.link.label}</LpArrowLink>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type PageHeroProps = {
  heading: string;
  sub: string;
  children: ReactNode;
  note?: string;
};

export function CompareHero({ heading, sub, children, note }: PageHeroProps) {
  return (
    <header className="pb-14 pt-16 text-center md:pb-20 md:pt-[104px]">
      <h1 className="mx-auto max-w-[820px] text-[40px] font-light leading-[46px] tracking-[-0.025em] [text-wrap:balance] md:text-[60px] md:leading-[64px]">
        {heading}
      </h1>
      <p className="mx-auto mt-6 max-w-[560px] text-[17px] leading-[27px] text-[var(--lp-body)] [text-wrap:balance] md:text-[18px] md:leading-[29px]">
        {sub}
      </p>
      <div className="mt-8 flex justify-center">{children}</div>
      {note ? <p className="mt-4 text-[13px] text-[var(--lp-muted)]">{note}</p> : null}
    </header>
  );
}

export function CompareSection({
  id,
  heading,
  children,
  narrow = false
}: {
  id: string;
  heading: string;
  children: ReactNode;
  /** Constrain heading and content to a reading width, for two-column tables. */
  narrow?: boolean;
}) {
  return (
    <section aria-labelledby={id} className={`scroll-mt-28 py-12 md:py-16 ${narrow ? "mx-auto max-w-[760px]" : ""}`}>
      <h2
        id={id}
        className="mb-9 text-[32px] font-light leading-[38px] tracking-[-0.015em] md:text-[40px] md:leading-[46px]"
      >
        {heading}
      </h2>
      {children}
    </section>
  );
}
