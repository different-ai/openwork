"use client";

import { forwardRef, type HTMLAttributes } from "react";

/**
 * Visual density presets for cards.
 *
 * Den surfaces never use drop shadows — flat borders only. If you need to
 * emphasise a card, use a darker border, a coloured background, or the
 * gradient hero (see `DashboardPageTemplate`). Do NOT reintroduce shadows.
 */
export type DenCardSize = "comfortable" | "spacious";

const sizeClasses: Record<DenCardSize, string> = {
  // Matches the original Members / API Keys inline card.
  comfortable: "rounded-[30px] p-6",
  // Matches the editor-screen section card (LLM providers, skill hubs).
  spacious: "rounded-[36px] p-8",
};

export type DenCardProps = HTMLAttributes<HTMLDivElement> & {
  size?: DenCardSize;
};

/**
 * DenCard
 *
 * Reusable surface container for the Den dashboard.
 *
 * Intentional constraints:
 * - No drop shadows. Ever.
 * - No hover transforms. Cards are surfaces, not buttons.
 * - Single, borderable background (`border-gray-200 bg-white`).
 *
 * Pick a size that matches the surrounding flow:
 * - `comfortable` (default): forms, summary cards, inline editors.
 * - `spacious`: detail/editor pages with multiple stacked sections.
 *
 * Anything more opinionated (headings, toolbars, descriptions) belongs in a
 * higher-level composition, not in this primitive.
 */
export const DenCard = forwardRef<HTMLDivElement, DenCardProps>(function DenCard(
  { size = "comfortable", className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      {...rest}
      className={[
        "border border-gray-200 bg-white",
        sizeClasses[size],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
});
