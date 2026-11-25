"use client";

import type { ElementType, ReactNode } from "react";
import { DenPageHeader } from "./page-header";
import { DASHBOARD_PAGE_CLASS, SETTINGS_MEASURE_CLASS } from "./dashboard-styles";

export type DashboardPageTemplateProps = {
  icon?: ElementType<{
    size?: number;
    className?: string;
    strokeWidth?: number;
  }>;
  title: string;
  description: ReactNode;
  state?: ReactNode;
  action?: ReactNode;
  size?: "default" | "compact" | "responsive";
  descriptionPlacement?: "below" | "hero";
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

      {children}
      </div>
    </div>
  );
}
