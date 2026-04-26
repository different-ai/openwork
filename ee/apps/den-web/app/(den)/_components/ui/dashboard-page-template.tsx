"use client";

import type { ElementType } from "react";

/**
 * DashboardPageTemplate
 *
 * A consistent page shell for all org dashboard pages.
 */

export type DashboardPageTemplateProps = {
  /** Lucide (or any) icon component rendered in the page header. */
  icon: ElementType<{
    size?: number;
    className?: string;
    strokeWidth?: number;
  }>;
  /** Short label rendered as a muted pill above the title. Omit to hide. */
  badgeLabel?: string;
  /** Page heading rendered inside the page header. */
  title: string;
  /** One-liner rendered below the heading. */
  description: string;
  /** Kept for existing callers while the shared template renders a neutral OpenWork shell. */
  colors: [string, string, string, string];
  children?: React.ReactNode;
};

export function DashboardPageTemplate({
  icon: Icon,
  badgeLabel,
  title,
  description,
  children,
}: DashboardPageTemplateProps) {
  return (
    <div className="mx-auto max-w-[900px] px-5 py-6 md:px-8 md:py-8">
      <header className="mb-6 overflow-hidden rounded-3xl border border-gray-200 bg-white">
        <div className="flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between md:p-8">
          <div className="max-w-[36rem]">
            {badgeLabel ? (
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                  {badgeLabel}
                </span>
              </div>
            ) : null}
            <h1 className="text-[30px] font-semibold leading-tight tracking-normal text-gray-950 md:text-[34px]">
              {title}
            </h1>
            <p className="mt-3 max-w-[38rem] text-[14px] leading-6 text-gray-500">
              {description}
            </p>
          </div>

          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-gray-200 bg-gray-50 text-gray-950">
            <Icon size={23} strokeWidth={1.75} />
          </div>
        </div>
      </header>

      {children}
    </div>
  );
}
