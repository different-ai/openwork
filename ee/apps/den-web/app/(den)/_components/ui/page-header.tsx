import type { ReactNode } from "react";

/**
 * DenPageHeader
 *
 * Flat page header for dashboard pages that lead with content instead of the
 * gradient hero (`DashboardPageTemplate`): title and description on the left,
 * the page's primary action plus an optional caption on the right.
 */
export type DenPageHeaderProps = {
  title: string;
  description?: ReactNode;
  /** Right-aligned slot for the page's primary action. */
  action?: ReactNode;
  /** Muted line under the action — pricing, counts, sync timestamps. */
  caption?: ReactNode;
  className?: string;
};

export function DenPageHeader({ title, description, action, caption, className = "" }: DenPageHeaderProps) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-8 ${className}`}>
      <div className="min-w-0">
        <h1 className="text-[28px] font-medium leading-[34px] tracking-[-0.5px] text-gray-950">{title}</h1>
        {description ? <p className="mt-2 text-[14px] leading-[20px] text-gray-500">{description}</p> : null}
      </div>
      {action || caption ? (
        <div className="flex shrink-0 flex-col items-end gap-2">
          {action}
          {caption ? <p className="text-[12px] leading-4 text-gray-400">{caption}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
