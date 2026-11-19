"use client";

import type { ElementType, ReactNode } from "react";
import { DenPageHeader } from "./page-header";
import { DASHBOARD_PAGE_CLASS, SETTINGS_MEASURE_CLASS } from "./dashboard-styles";

/**
 * Shared shell for org dashboard pages, all beneath OrgDashboardProvider:
 * the Computers page's column and compact header (title, one optional line of
 * state, one action), then page content.
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
  /** Supporting context under the title. Prefer `state` (DESIGN.md P1, P2). */
  description: ReactNode;
  /** One muted line of state under the title ("18 members · 4 invited"). */
  state?: ReactNode;
  /** The page's one primary action, right of the title. */
  action?: ReactNode;
  /** Retained for compatibility; all pages use the shared Trim header size. */
  size?: "default" | "compact" | "responsive";
  /** Retained for compatibility; supporting copy always renders below the header. */
  descriptionPlacement?: "below" | "hero";
  /** A settings page: the heading and content keep the settings measure together, centred. */
  measure?: boolean;
  children?: React.ReactNode;
};

export function DashboardPageTemplate({
  title,
  description,
  state,
  action,
  measure = false,
  children,
}: DashboardPageTemplateProps) {
  return (
    <div className={DASHBOARD_PAGE_CLASS}>
      <div className={measure ? SETTINGS_MEASURE_CLASS : undefined}>
      <div data-dashboard-flat-header>
        <DenPageHeader title={title} size="compact" state={state} action={action} className={description ? "mb-1 break-words" : "mb-6 break-words"} />
      </div>

      {description ? <p className="mb-6 text-[13px] text-[var(--dls-text-secondary)]">{description}</p> : null}

      {/* ── Page content ── */}
      {children}
      </div>
    </div>
  );
}
