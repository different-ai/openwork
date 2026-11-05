"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleCaption } from "../example-parts";
import { teamPromptExampleRows } from "./team-prompt-example-data";

/** Prompts example: the prompt for everyone, then a team's, as the Prompts tab shows them. */
export function TeamPromptExample() {
  const step = useExampleStep(teamPromptExampleRows.length, 3200);

  return (
    <div>
      <ExampleCaption>What every agent is told</ExampleCaption>
      <div className="flex flex-col gap-3">
        {teamPromptExampleRows.map((row, index) => (
          <div key={row.title} className="flex flex-col gap-1.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[12px] font-semibold text-gray-900">{row.title}</span>
              <span className="shrink-0 text-[12px] text-gray-500">{row.state}</span>
            </span>
            <span
              className={`rounded-lg border px-3 py-2 font-mono text-[12px] leading-5 transition-colors duration-200 ease-out ${step === index ? "border-gray-300 bg-gray-50 text-gray-900" : "border-gray-200 text-gray-700"}`}
            >
              {row.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
