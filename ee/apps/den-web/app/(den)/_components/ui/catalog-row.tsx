import Link from "next/link";
import type { ReactNode } from "react";

export type DenCatalogListProps = {
  /** Left label, usually the count ("6 marketplaces"). */
  label: string;
  /** Right label above the figure column ("Plugins", "Components"). */
  valueLabel?: string;
  /** Width of the trailing figure column. Must match the rows in this list. */
  valueWidth?: string;
  children: ReactNode;
  className?: string;
};

/**
 * DenCatalogList
 *
 * Divided list for catalogue surfaces (marketplaces, plugins). Hierarchy comes
 * from type and rhythm rather than boxes, so rows fill the available width
 * instead of being padded out to match a neighbour in a grid.
 */
export function DenCatalogList({
  label,
  valueLabel,
  valueWidth = "120px",
  children,
  className = "",
}: DenCatalogListProps) {
  return (
    <div className={className}>
      <div className="flex items-center gap-3.5 pb-2.5">
        <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-gray-400">
          {label}
        </span>
        {valueLabel ? (
          <span
            className="text-right text-[10.5px] font-semibold uppercase tracking-[0.14em] text-gray-400"
            style={{ width: valueWidth }}
          >
            {valueLabel}
          </span>
        ) : null}
      </div>
      <div data-testid="catalog-list" className="divide-y divide-gray-100 border-t border-gray-200">
        {children}
      </div>
    </div>
  );
}

export type DenCatalogRowProps = {
  /** Usually a CatalogIdentityTile. Sits in a fixed slot so titles align. */
  leading?: ReactNode;
  title: string;
  /** Renders the title in mono for identifiers matched against a repository. */
  monospacedTitle?: boolean;
  /** Sits beside the title: "Built in", or a readiness exception. */
  badge?: ReactNode;
  description?: ReactNode;
  /** Uppercase micro-label under the description, e.g. owning marketplaces. */
  meta?: ReactNode;
  /** Figure for the trailing column. Rendered in mono so counts compare. */
  value?: string;
  /** Dims the figure when it is a zero rather than a quantity. */
  valueMuted?: boolean;
  valueCaption?: string;
  valueWidth?: string;
  href?: string;
  /** Trailing control for rows that are not themselves a link. */
  action?: ReactNode;
  id?: string;
  className?: string;
};

/**
 * DenCatalogRow
 *
 * One entry in a DenCatalogList. The leading tile and trailing figure use fixed
 * slots so identity and counts line up down the column regardless of how long
 * the titles and descriptions are.
 */
export function DenCatalogRow({
  leading,
  title,
  monospacedTitle = false,
  badge,
  description,
  meta,
  value,
  valueMuted = false,
  valueCaption,
  valueWidth = "120px",
  href,
  action,
  id,
  className = "",
}: DenCatalogRowProps) {
  const body = (
    <>
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span
            data-testid="catalog-row-title"
            className={`truncate text-[16px] leading-[22px] font-semibold tracking-[-0.025em] text-gray-900 ${
              monospacedTitle ? "font-mono text-[13px] tracking-normal" : ""
            }`}
          >
            {title}
          </span>
          {badge ? <span data-testid="catalog-row-badge">{badge}</span> : null}
        </div>
        {description ? (
          <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[18px] text-gray-500">{description}</p>
        ) : null}
        {meta ? (
          <p className="mt-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.1em] text-gray-400">
            {meta}
          </p>
        ) : null}
      </div>
      {value ? (
        <div className="flex shrink-0 flex-col items-end gap-px" style={{ width: valueWidth }}>
          <span
            data-testid="catalog-row-value"
            data-muted={valueMuted ? "true" : "false"}
            className={`font-mono text-[17px] leading-[22px] ${valueMuted ? "text-gray-400" : "text-gray-900"}`}
          >
            {value}
          </span>
          {valueCaption ? <span className="text-[11px] text-gray-400">{valueCaption}</span> : null}
        </div>
      ) : null}
      {action}
    </>
  );

  const rowClassName = `flex items-center gap-3.5 py-[15px] ${className}`;

  if (href) {
    return (
      <Link
        id={id}
        data-testid="catalog-row"
        href={href}
        className={`${rowClassName} group scroll-mt-6 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dls-accent)]`}
      >
        {body}
      </Link>
    );
  }

  return (
    <div id={id} data-testid="catalog-row" className={`${rowClassName} scroll-mt-6`}>
      {body}
    </div>
  );
}
