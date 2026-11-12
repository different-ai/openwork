"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleProviderMark } from "../ai-gateway/example-parts";
import { ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows } from "../example-parts";
import {
  teamModelsExampleDefault,
  teamModelsExampleLimit,
  teamModelsExampleProviders,
  teamModelsExampleTeam,
} from "./team-models-example-data";

/** Team models example: the model new chats start on, the providers the team can use and its spend limit. */
export function TeamModelsExample() {
  const step = useExampleStep(teamModelsExampleProviders.length);

  return (
    <div>
      <ExampleCaption>{teamModelsExampleTeam}&apos;s models</ExampleCaption>
      <ExampleGroupLabel>Default model</ExampleGroupLabel>
      <div className="mb-3 flex min-h-9 items-center gap-2.5">
        <ExampleProviderMark provider={teamModelsExampleDefault.provider} size="sm" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-gray-900">{teamModelsExampleDefault.model}</span>
      </div>

      <ExampleGroupLabel>Can use</ExampleGroupLabel>
      <ExampleRows>
        {teamModelsExampleProviders.map((row, index) => (
          <ExampleRow key={row.provider.providerId} active={step === index}>
            <ExampleProviderMark provider={row.provider} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.provider.name}</span>
              <span className="truncate text-[12px] text-gray-500">{row.models}</span>
            </span>
            <span className="shrink-0 text-[12px] text-gray-500">{row.source}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div className="mt-3 border-t border-gray-100 pt-3">
        <ExampleGroupLabel meta={`${teamModelsExampleLimit.used} of ${teamModelsExampleLimit.amount}`}>Spend limit</ExampleGroupLabel>
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-gray-100">
          <span className="block h-1 rounded-full bg-gray-900" style={{ width: `${teamModelsExampleLimit.percent}%` }} />
        </span>
      </div>
    </div>
  );
}
