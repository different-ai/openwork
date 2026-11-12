"use client";

import { Globe } from "lucide-react";
import { useExampleStep } from "../use-example-step";
import { ExampleProviderMark } from "../ai-gateway/example-parts";
import { ExampleAvatar, ExampleCaption, ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { teamsExampleEveryone, teamsExampleRows } from "./teams-example-data";

/** Teams tab example: each team, its size and role, and the models, apps and plugin it is given. */
export function TeamsExample() {
  const step = useExampleStep(teamsExampleRows.length, 3000);

  return (
    <div>
      <ExampleCaption>Teams and what each one gets</ExampleCaption>
      <ExampleRows>
        <ExampleRow>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
            <Globe className="size-3.5" strokeWidth={1.5} aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium text-gray-900">{teamsExampleEveryone.name}</span>
            <span className="truncate text-[12px] text-gray-500">{teamsExampleEveryone.detail}</span>
          </span>
          <span className="shrink-0 text-[12px] tabular-nums text-gray-500">{teamsExampleEveryone.people}</span>
        </ExampleRow>
        {teamsExampleRows.map((row, index) => (
          <ExampleRow key={row.name} active={step === index}>
            <ExampleAvatar>{row.initials}</ExampleAvatar>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.people}, {row.role}, {row.plugins}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {row.providers.map((provider) => <ExampleProviderMark key={provider.providerId} provider={provider} size="sm" />)}
              {row.services.map((service) => <ExampleServiceMark key={service.name} service={service} size="sm" />)}
            </span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
