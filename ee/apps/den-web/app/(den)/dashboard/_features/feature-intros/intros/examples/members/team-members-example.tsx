"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleProviderMark } from "../ai-gateway/example-parts";
import { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { teamMembersExampleGets, teamMembersExampleRows, teamMembersExampleTeam } from "./team-members-example-data";

/** Team members example: the people in a team, then what each of them gets from it. */
export function TeamMembersExample() {
  const step = useExampleStep(teamMembersExampleRows.length);

  return (
    <div>
      <ExampleCaption>{teamMembersExampleTeam}, once people are in it</ExampleCaption>
      <ExampleRows>
        {teamMembersExampleRows.map((row, index) => (
          <ExampleRow key={row.name} active={step === index}>
            <ExampleAvatar>{row.initials}</ExampleAvatar>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{row.name}</span>
            <span className="shrink-0 truncate text-[12px] text-gray-500">{row.detail}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <ExampleGroupLabel>Each of them gets</ExampleGroupLabel>
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 items-center gap-1">
            {teamMembersExampleGets.providers.map((provider) => <ExampleProviderMark key={provider.providerId} provider={provider} size="sm" />)}
            {teamMembersExampleGets.services.map((service) => <ExampleServiceMark key={service.name} service={service} size="sm" />)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-gray-700">{teamMembersExampleGets.plugins}</span>
        </div>
      </div>
    </div>
  );
}
