import type { ReactNode } from "react";

export type DenTableColumn<T> = {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
};

export type DenTableProps<T> = {
  columns: readonly DenTableColumn<T>[];
  rows: readonly T[];
  getRowKey: (row: T) => string;
  emptyLabel?: string;
};

export function DenTable<T>({ columns, rows, getRowKey, emptyLabel = "Nothing here yet." }: DenTableProps<T>) {
  if (rows.length === 0) {
    return <p className="px-6 py-5 text-[13px] text-gray-500">{emptyLabel}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-[14px]">
        <thead className="bg-gray-50 text-[12px] uppercase tracking-[0.08em] text-gray-500">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-6 py-3 font-medium ${column.align === "right" ? "text-right" : ""}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={`px-6 py-3 ${column.align === "right" ? "text-right" : ""}`}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
