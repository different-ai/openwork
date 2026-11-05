"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleAvatar, ExampleCaption, ExampleProviderMarks, ExampleRow, ExampleRows } from "./example-parts";
import { usersTeamsExampleRows } from "./users-teams-example-data";

/** The people and teams directory: who can use which models, their limit and spend. */
export function UsersTeamsExample() {
  const step = useExampleStep(usersTeamsExampleRows.length, 3000);
  return (
    <div>
      <ExampleCaption>Who can use what, last 31 days</ExampleCaption>
      <ExampleRows>
        {usersTeamsExampleRows.map((row, index) => (
          <ExampleRow key={row.name} active={step === index}>
            <ExampleAvatar>{row.initials}</ExampleAvatar>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.detail}, {row.limit === "No limit" ? "no limit" : row.limit}</span>
            </span>
            <ExampleProviderMarks providers={row.providers} />
            <span className="w-11 shrink-0 text-right text-[13px] font-semibold tabular-nums text-gray-950">{row.spend}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
