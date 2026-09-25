import { Fragment, type ReactNode } from "react";

export type DenTableColumn<T> = {
  key: string;
  header: string;
  align?: "left" | "right";
  /** Fixed lane width (e.g. "190px") so cells stay aligned across rows. */
  width?: string;
  render: (row: T) => ReactNode;
};

export type DenTableProps<T> = {
  columns: readonly DenTableColumn<T>[];
  rows: readonly T[];
  getRowKey: (row: T) => string;
  rowClassName?: string;
  density?: "default" | "compact";
  renderRowDetail?: (row: T) => ReactNode;
  emptyLabel?: string;
  /** `plain` drops the filled header row for tables that sit on a white surface. */
  headerTone?: "muted" | "plain";
};

export function DenTable<T>({
  columns,
  rows,
  getRowKey,
  rowClassName,
  renderRowDetail,
  emptyLabel = "Nothing here yet.",
  headerTone = "muted",
  density = "default",
}: DenTableProps<T>) {
  const compact = density === "compact";
  const cellClass = compact ? "px-3 py-2 text-[13px] align-top" : "px-6 py-3";
  if (rows.length === 0) {
    return <p className="px-6 py-5 text-[13px] text-gray-500">{emptyLabel}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-[14px]">
        <thead
          className={
            compact ? "border-b border-[var(--dls-border)] text-xs text-[var(--dls-text-secondary)]" : headerTone === "plain"
              ? "border-b border-gray-100 text-[12px] uppercase tracking-[0.05em] text-gray-400"
              : "bg-gray-50 text-[12px] uppercase tracking-[0.08em] text-gray-500"
          }
        >
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={`${cellClass} font-medium ${column.align === "right" ? "text-right" : ""}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={compact ? "divide-y divide-[var(--dls-border)]" : renderRowDetail ? undefined : "divide-y divide-gray-100"}>
          {rows.map((row) => {
            const detail = renderRowDetail?.(row);
            return (
              <Fragment key={getRowKey(row)}>
                <tr className={rowClassName}>
                  {columns.map((column) => (
                    <td key={column.key} className={`${cellClass} ${column.align === "right" ? "text-right" : ""}`}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {renderRowDetail && (!compact || detail) ? <tr className={compact ? "border-b border-[var(--dls-border)] last:border-b-0" : "border-b border-gray-100 last:border-b-0"}>
                  <td colSpan={columns.length} className={compact ? "px-3 pb-4 pt-0" : "px-6 pb-4 pt-0"}>{detail}</td>
                </tr> : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
