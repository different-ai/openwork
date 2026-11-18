"use client";

import { ExampleCaption, ExampleGroupLabel, ExampleProviderMark, ExampleRow, ExampleRows } from "./example-parts";
import { OPENWORK_MODELS } from "./gateway-example-data";
import { openworkModelsExampleLineup, openworkModelsExampleWeeklyLeft } from "./openwork-models-example-data";

/** On for everyone: the lineup with what each model is best for, and included usage left. */
export function OpenWorkModelsExample() {
  return (
    <div>
      <ExampleCaption>OpenWork Models, once on</ExampleCaption>

      <div className="mb-3 flex items-center gap-3">
        <ExampleProviderMark provider={OPENWORK_MODELS} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">On for everyone</span>
          <span className="truncate text-[12px] text-gray-500">No API keys to manage</span>
        </span>
      </div>

      <ExampleGroupLabel>Models</ExampleGroupLabel>
      <ExampleRows>
        {openworkModelsExampleLineup.map((model) => (
          <ExampleRow key={model.name}>
            <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-gray-100 text-[11px] font-semibold text-gray-600">
              {model.monogram}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{model.name}</span>
            <span className="shrink-0 text-[12px] text-gray-500">{model.bestFor}</span>
          </ExampleRow>
        ))}
      </ExampleRows>

      <div className="mt-3 flex flex-col gap-2 border-t border-gray-100 pt-3">
        <div className="flex items-baseline gap-3">
          <span className="flex-1 text-[12px] text-gray-500">Weekly included usage</span>
          <span className="text-[13px] font-semibold tabular-nums text-gray-950">{openworkModelsExampleWeeklyLeft}% left</span>
        </div>
        <span className="block h-1 overflow-hidden rounded-full bg-gray-100">
          <span className="block h-1 rounded-full bg-[var(--dls-accent)]" style={{ width: `${openworkModelsExampleWeeklyLeft}%` }} />
        </span>
      </div>
    </div>
  );
}
