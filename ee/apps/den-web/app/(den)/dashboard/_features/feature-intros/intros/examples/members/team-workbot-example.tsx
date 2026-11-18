"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleProviderMark } from "../ai-gateway/example-parts";
import { ExampleCaption, ExampleRow, ExampleRows } from "../example-parts";
import { teamWorkbotExampleRows } from "./team-workbot-example-data";

/** Team Workbot example: whether each team has Workbot, its name and the model it starts on, Everyone's or its own. */
export function TeamWorkbotExample() {
  const step = useExampleStep(teamWorkbotExampleRows.length);

  return (
    <div>
      <ExampleCaption>Workbot for each team</ExampleCaption>
      <ExampleRows>
        {teamWorkbotExampleRows.map((row, index) => (
          <ExampleRow key={row.team} active={step === index}>
            <ExampleProviderMark provider={row.provider} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-gray-900">{row.team}</span>
              <span className="truncate text-[12px] text-gray-500">{row.enabled ? `${row.name}, ${row.model}` : "Workbot is off"}</span>
            </span>
            <span className="shrink-0 text-[12px] text-gray-500">{row.source}</span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
