"use client";

import { ShareBar } from "../../../../../_components/gateway-spend-breakdown";
import { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows } from "./example-parts";
import { overviewExampleDaily, overviewExampleTopPeople, overviewExampleTotal } from "./overview-example-data";

/** Team spend over time and the people using the most. */
export function OverviewExample() {
  const maxDay = Math.max(...overviewExampleDaily);
  const maxPerson = overviewExampleTopPeople[0]?.value ?? 0;
  return (
    <div>
      <ExampleCaption>Team spend, once people use it</ExampleCaption>

      <div className="mb-1 flex items-baseline gap-3">
        <span className="flex-1 text-[12px] text-gray-500">Last 14 days</span>
        <span className="text-[15px] font-semibold tabular-nums text-gray-950">{overviewExampleTotal}</span>
      </div>
      <div className="mb-4 flex h-16 items-end gap-1">
        {overviewExampleDaily.map((value, index) => (
          <span
            key={index}
            className={`flex-1 rounded-[3px] ${index === overviewExampleDaily.length - 1 ? "bg-gray-900" : "bg-gray-300"}`}
            style={{ height: `${Math.max(8, Math.round((value / maxDay) * 100))}%` }}
          />
        ))}
      </div>

      <ExampleGroupLabel>Top people</ExampleGroupLabel>
      <ExampleRows>
        {overviewExampleTopPeople.map((person) => (
          <ExampleRow key={person.name}>
            <ExampleAvatar>{person.initials}</ExampleAvatar>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{person.name}</span>
            <ShareBar value={person.value} max={maxPerson} label={`${person.name}: ${person.spend}`} />
            <span className="w-11 shrink-0 text-right text-[13px] font-semibold tabular-nums text-gray-950">{person.spend}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
