"use client";

import { Check } from "lucide-react";
import { useExampleStep } from "../use-example-step";
import { ExampleRow, ExampleRows, ExampleServiceMark } from "../example-parts";
import { addExampleChecks, addExampleService } from "./add-example-data";

/** Add a connector example: the checks run one after another; static and all done under reduced motion. */
export function ConnectorAddExample() {
  // One extra step holds everything done before starting again.
  const step = useExampleStep(addExampleChecks.length + 1, 1800);
  const doneCount = step === null ? addExampleChecks.length : step;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <ExampleServiceMark service={addExampleService} />
        <span className="truncate text-[13px] font-medium text-gray-900">Add {addExampleService.name}</span>
      </div>

      <ExampleRows>
        {addExampleChecks.map((check, index) => {
          const done = index < doneCount;
          const current = index === doneCount;
          return (
            <ExampleRow key={check.title} active={current}>
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ease-out ${done ? "border-emerald-600 bg-emerald-600 text-white" : "border-gray-300 bg-white"}`}
              >
                {done ? <Check className="size-3" strokeWidth={2} /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={`truncate text-[13px] font-medium ${done || current ? "text-gray-900" : "text-gray-500"}`}>{check.title}</span>
                <span className="truncate text-[12px] text-gray-500">{done ? check.done : current ? "Checking now." : "Waits for the check above."}</span>
              </span>
            </ExampleRow>
          );
        })}
      </ExampleRows>
    </div>
  );
}
