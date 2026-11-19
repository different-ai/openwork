"use client";

import { LetterTile } from "../../../../../_components/item-logo";
import { ExampleCaption, ExampleRow, ExampleRows } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { libraryUsageExampleRows } from "./library-usage-example-data";

/** Tab example: skills with their uses and last use, one not used yet. Narrow enough for the 40% column. */
export function LibraryUsageExample() {
  const step = useExampleStep(libraryUsageExampleRows.length);

  return (
    <div>
      <ExampleCaption>Skills your team used, last 30 days</ExampleCaption>
      <div className="flex gap-3 pb-1 text-[12px] text-gray-500">
        <span className="min-w-0 flex-1">Skill</span>
        <span className="w-10 shrink-0 text-right">Uses</span>
        <span className="w-[76px] shrink-0 text-right">Last used</span>
      </div>
      <ExampleRows>
        {libraryUsageExampleRows.map((row, index) => (
          <ExampleRow key={row.name} active={step === index}>
            <LetterTile name={row.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-gray-900">{row.name}</span>
              <span className="block truncate text-[12px] text-gray-500">{row.plugin}</span>
            </span>
            <span className="w-10 shrink-0 text-right text-[13px] tabular-nums text-gray-900">{row.uses}</span>
            <span className="w-[76px] shrink-0 truncate text-right text-[12px] text-gray-500">{row.lastUsed}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
