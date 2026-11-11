import type { ReactNode } from "react";

/**
 * DenPageHeader
 *
 * Flat page header for dashboard pages that lead with content instead of the
 * gradient hero (`DashboardPageTemplate`): title and description on the left,
 * the page's primary action plus an optional caption on the right.
 */
export type DenPageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  /** One muted line of state right under the title ("6 of 17 online"), instead of a description. */
  state?: ReactNode;
  /** Right-aligned slot for the page's primary action. */
  action?: ReactNode;
  /** Muted line under the action — pricing, counts, sync timestamps. */
  caption?: ReactNode;
  className?: string;
  size?: "default" | "compact";
};

export function DenPageHeader({ title, description, state, action, caption, className = "", size = "default" }: DenPageHeaderProps) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-8 ${className}`}>
      <div className="min-w-0 flex-1">
        <h1 className={size === "compact" ? "text-xl font-semibold tracking-tight text-[var(--dls-text-primary)]" : "text-[28px] font-medium leading-[34px] tracking-[-0.5px] text-gray-950"}>{title}</h1>
        {state ? <p className="mt-0.5 text-[12px] leading-4 text-[var(--dls-text-secondary)]" data-page-state>{state}</p> : null}
        {description ? <p className="mt-2 max-w-3xl text-[14px] leading-[20px] text-gray-500">{description}</p> : null}
      </div>
      {action || caption ? (
        <div className="ml-auto flex shrink-0 flex-col items-end gap-2">
          {action}
          {caption ? <p className="text-[12px] leading-4 text-gray-400">{caption}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
