"use client";

import { DenChip } from "../../../../../../_components/ui/chip";
import { ExampleAvatar, ExampleCaption, ExampleRow, ExampleRows } from "./example-parts";
import { limitsExampleRows, type LimitsExampleRow } from "./limits-example-data";

/** Neutral while there is room; amber near the limit, red once a limit has paused someone (V2). */
function meterTone(row: LimitsExampleRow): string {
  if (row.percent >= 100) return row.whenReached === "Pauses them" ? "bg-red-500" : "bg-amber-500";
  if (row.percent >= 80) return "bg-amber-500";
  return "bg-gray-900";
}

/** Team and person limits with how much of each is used. */
export function LimitsExample() {
  return (
    <div>
      <ExampleCaption>Spend limits this period</ExampleCaption>
      <ExampleRows>
        {limitsExampleRows.map((row) => {
          const paused = row.percent >= 100 && row.whenReached === "Pauses them";
          return (
            <ExampleRow key={row.who}>
              <ExampleAvatar>{row.initials}</ExampleAvatar>
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{row.who}</span>
                  <span className="shrink-0 text-[12px] tabular-nums text-gray-600">
                    <span className="font-medium text-gray-900">{row.used}</span> of {row.amount}
                  </span>
                </span>
                <span className="block h-1 overflow-hidden rounded-full bg-gray-100">
                  <span
                    className={`block h-1 rounded-full transition-[width] duration-200 ease-out ${meterTone(row)}`}
                    style={{ width: `${Math.min(100, row.percent)}%` }}
                  />
                </span>
                <span className="flex items-center gap-2 text-[12px] text-gray-500">
                  <span className="flex-1">{row.whenReached}</span>
                  {paused ? <DenChip tone="danger">Paused</DenChip>
                    : row.percent >= 80 ? <span className="text-amber-700">{row.percent}% used</span>
                      : <span>{row.percent}% used</span>}
                </span>
              </span>
            </ExampleRow>
          );
        })}
      </ExampleRows>
    </div>
  );
}
