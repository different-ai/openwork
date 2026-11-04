"use client";

import { LetterTile } from "../../../../../_components/item-logo";
import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleRow, ExampleRows } from "../example-parts";
import { teamAccessExampleRows, teamAccessExampleTeam } from "./team-access-example-data";

/** Team access example: plugins a team can use, and where each grant comes from. */
export function TeamAccessExample() {
  const step = useExampleStep(teamAccessExampleRows.length);

  return (
    <div>
      <ExampleCaption>What {teamAccessExampleTeam} can use</ExampleCaption>
      <ExampleRows>
        {teamAccessExampleRows.map((row, index) => (
          <ExampleRow key={row.name} active={step === index}>
            <LetterTile name={row.name} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.inside}</span>
            </span>
            <span className="max-w-[45%] shrink-0 truncate text-right text-[12px] text-gray-500">{row.source}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
