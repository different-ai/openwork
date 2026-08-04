import type { ReactNode } from "react";

export type DenMarkTileProps = {
  /** Short mark such as "4/5" or "4x". Rendered in mono so figures align. */
  label: string;
  /** Solid tile when the thing is billing, muted when it is not. */
  active?: boolean;
  className?: string;
};

/**
 * DenMarkTile
 *
 * Small square that carries the number driving a row, matching the icon tile
 * geometry used by DenToggleRow.
 */
export function DenMarkTile({ label, active = false, className = "" }: DenMarkTileProps) {
  return (
    <span
      aria-hidden
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] font-mono text-[12px] font-medium ${
        active ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500"
      } ${className}`}
    >
      {label}
    </span>
  );
}

export type DenLineItemRowProps = {
  /** Usually a DenMarkTile. */
  leading?: ReactNode;
  title: string;
  description?: ReactNode;
  value: string;
  valueCaption?: string;
  /** Usually a DenBadge. */
  badge?: ReactNode;
  /** Emphasised summing row. Drops the badge slot and enlarges the value. */
  emphasis?: boolean;
  className?: string;
};

/**
 * DenLineItemRow
 *
 * Read-only counterpart to DenSelectableRow, for statements and receipts where
 * each row is a charge rather than a choice. Leading, value, and badge sit in
 * fixed-width slots so figures and status align down the column.
 */
export function DenLineItemRow({
  leading,
  title,
  description,
  value,
  valueCaption,
  badge,
  emphasis = false,
  className = "",
}: DenLineItemRowProps) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3.5 ${className}`}>
      <div className="w-9 shrink-0">{leading}</div>
      <div className="min-w-0 flex-1">
        <p className={`text-[14px] ${emphasis ? "font-medium text-gray-700" : "font-medium text-gray-950"}`}>{title}</p>
        {description ? <p className="mt-0.5 text-[12px] leading-4 text-gray-500">{description}</p> : null}
      </div>
      <div className="flex w-[112px] shrink-0 flex-col items-end gap-0.5">
        <span
          className={
            emphasis
              ? "text-[20px] font-semibold tracking-[-0.03em] text-gray-950"
              : "text-[15px] font-medium text-gray-950"
          }
        >
          {value}
        </span>
        {valueCaption ? <span className="text-[12px] text-gray-500">{valueCaption}</span> : null}
      </div>
      <div className="flex w-[96px] shrink-0 justify-end">{emphasis ? null : badge}</div>
    </div>
  );
}
