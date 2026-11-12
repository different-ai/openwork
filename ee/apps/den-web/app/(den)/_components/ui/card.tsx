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
  // The My Automations card: the one card surface on org/admin pages.
  comfortable: "rounded-2xl p-4",
  // Editor-screen sections with more inside (LLM providers, plugin marketplaces).
  spacious: "rounded-2xl p-6",
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
 * - Single, borderable background (the Automations card: quiet shell hairline, top-bar surface).
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
        "border border-[var(--den-shell-line)] bg-[var(--den-shell-topbar)]",
        sizeClasses[size],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
});
