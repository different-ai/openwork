"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleRow, ExampleRows } from "../example-parts";
import { teamAgentsExampleRows, teamAgentsExampleTeam, teamBrowserExampleRows, type TeamAgentsExampleRow } from "./team-agents-example-data";

function PermissionRows({ rows }: { rows: readonly TeamAgentsExampleRow[] }) {
  const step = useExampleStep(rows.length);
  return (
    <ExampleRows>
      {rows.map((row, index) => (
        <ExampleRow key={row.title} active={step === index}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium text-gray-900">{row.title}</span>
            <span className="truncate text-[12px] text-gray-500">{row.detail}</span>
          </span>
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">{row.choice}</span>
        </ExampleRow>
      ))}
    </ExampleRows>
  );
}

/** Agents tab example: what agents may do on a team's computers, and what differs from Everyone. */
export function TeamAgentsExample() {
  return (
    <div>
      <ExampleCaption>What agents can do for {teamAgentsExampleTeam}</ExampleCaption>
      <PermissionRows rows={teamAgentsExampleRows} />
    </div>
  );
}

/** Browser tab example: the websites agents and the built-in browser may open. */
export function TeamBrowserExample() {
  return (
    <div>
      <ExampleCaption>Websites for {teamAgentsExampleTeam}</ExampleCaption>
      <PermissionRows rows={teamBrowserExampleRows} />
    </div>
  );
}
