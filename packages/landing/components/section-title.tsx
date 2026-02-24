"use client";

import {
  ScrollVelocityContainer,
  ScrollVelocityRow,
} from "@/components/magicui/scroll-velocity";

interface SectionTitleProps {
  children: string;
  velocity?: number;
}

/**
 * A section title with scroll-based velocity animation.
 * The text scrolls horizontally and reacts to the user's scroll speed.
 */
export function SectionTitle({ children, velocity = 3 }: SectionTitleProps) {
  return (
    <ScrollVelocityContainer className="mb-3">
      <ScrollVelocityRow
        baseVelocity={velocity}
        direction={1}
        className="text-2xl font-bold tracking-tight text-gray-900/10 md:text-4xl"
      >
        {children}
      </ScrollVelocityRow>
    </ScrollVelocityContainer>
  );
}
