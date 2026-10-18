"use client";

import type { ElementType, ReactNode } from "react";
import { DenPageHeader } from "./page-header";

/**
 * Shared shell for org dashboard pages, all beneath OrgDashboardProvider:
 * a compact flat heading, supporting context, then page content.
 */

export type DashboardPageTemplateProps = {
  /** Retained for compatibility; the shared Trim header does not render an icon. */
  icon?: ElementType<{
    size?: number;
    className?: string;
    strokeWidth?: number;
  }>;
  /** Semantic page heading. */
  title: string;
  /** Supporting context retained above the page content. */
  description: ReactNode;
  /** Retained for compatibility; all pages use the shared Trim header size. */
  size?: "default" | "compact" | "responsive";
  /** Retained for compatibility; supporting copy always renders below the header. */
  descriptionPlacement?: "below" | "hero";
  children?: React.ReactNode;
  /** "wide" gives side-by-side comparisons room; reading pages stay at the default measure. */
  width?: "default" | "wide";
};

export function DashboardPageTemplate({
  title,
  description,
  children,
  width = "default",
}: DashboardPageTemplateProps) {
  return (
    <div className={`mx-auto ${width === "wide" ? "max-w-[1120px]" : "max-w-[860px]"} p-4 sm:p-6 md:p-8`}>
      <div data-dashboard-flat-header>
        <DenPageHeader title={title} size="compact" className="mb-1 break-words" />
      </div>

      <p className="mb-6 text-[14px] text-gray-500">{description}</p>

      {/* ── Page content ── */}
      {children}
    </div>
  );
}
