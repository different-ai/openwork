"use client";

import { Route } from "lucide-react";
import { DenChip } from "../../../../../../_components/ui/chip";
import { useExampleStep } from "../use-example-step";
import { ExampleCaption, ExampleGroupLabel, ExampleProviderMark, ExampleRow, ExampleRows } from "./example-parts";
import { smartRouterExampleModels, smartRouterExampleName, smartRouterExamplePrompts } from "./smart-router-example-data";

function modelName(modelId: string): string {
  return smartRouterExampleModels.find((model) => model.id === modelId)?.name ?? modelId;
}

/** One Smart model, three tagged models, and which one answered each sample prompt. */
export function SmartRouterExample() {
  const step = useExampleStep(smartRouterExamplePrompts.length);
  const activePrompt = step === null ? null : smartRouterExamplePrompts[step];

  return (
    <div>
      <ExampleCaption>What your team picks, and what answers</ExampleCaption>

      <div className="mb-3 flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-gray-100 bg-gray-50 text-gray-700">
          <Route className="size-4" strokeWidth={1.5} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{smartRouterExampleName}</span>
        <span className="shrink-0 text-[12px] text-gray-500">{smartRouterExampleModels.length} models</span>
      </div>

      <ExampleGroupLabel>Models and their tasks</ExampleGroupLabel>
      <ExampleRows>
        {smartRouterExampleModels.map((model) => (
          <ExampleRow key={model.id} active={activePrompt?.modelId === model.id}>
            <ExampleProviderMark provider={model.provider} size="sm" />
            <span className="w-24 shrink-0 truncate text-[13px] font-medium text-gray-900">{model.name}</span>
            <span className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
              {model.tasks.map((task) => <DenChip key={task}>{task}</DenChip>)}
            </span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div className="mt-4">
        <ExampleGroupLabel>Prompts this week</ExampleGroupLabel>
        <ExampleRows>
          {smartRouterExamplePrompts.map((entry) => (
            <ExampleRow key={entry.prompt} active={activePrompt === entry}>
              <span className="min-w-0 flex-1 truncate text-[13px] text-gray-700">{entry.prompt}</span>
              <span className="shrink-0 text-[12px] text-gray-500">
                <span className="font-medium text-gray-900">{modelName(entry.modelId)}</span>, {entry.thinking.toLowerCase()} thinking
              </span>
            </ExampleRow>
          ))}
        </ExampleRows>
      </div>
    </div>
  );
}
