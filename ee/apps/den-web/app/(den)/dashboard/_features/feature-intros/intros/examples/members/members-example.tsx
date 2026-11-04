"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows } from "../example-parts";
import { membersExampleCount, membersExampleRows } from "./members-example-data";

/** Quiet team chip, as on a member's row (V2: neutral). */
export function ExampleTeamChip({ children }: { children: string }) {
  return <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">{children}</span>;
}

/** Section example: people with their role and teams, and one invite waiting to be accepted. */
export function MembersExample() {
  const step = useExampleStep(membersExampleRows.length);

  return (
    <div>
      <ExampleCaption>Your organization, once your team joins</ExampleCaption>
      <ExampleGroupLabel meta={membersExampleCount}>Members</ExampleGroupLabel>
      <ExampleRows>
        {membersExampleRows.map((row, index) => (
          <ExampleRow key={row.email} active={step === index}>
            <ExampleAvatar>{row.initials}</ExampleAvatar>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={`truncate text-[13px] font-medium ${row.pending ? "text-gray-600" : "text-gray-900"}`}>{row.name}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-gray-500">
                <span className="shrink-0">{row.role}</span>
                {row.teams.map((team) => <ExampleTeamChip key={team}>{team}</ExampleTeamChip>)}
              </span>
            </span>
            <span className={`shrink-0 text-[12px] ${row.pending ? "font-medium text-gray-700" : "text-gray-500"}`}>{row.joined}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
