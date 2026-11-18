"use client";

import { LetterTile } from "../../../../../_components/item-logo";
import { ExampleCaption, ExampleRow, ExampleRows } from "../example-parts";
import { useExampleStep } from "../use-example-step";
import { workflowRunsExampleRows } from "./workflow-runs-example-data";

/** Tab example: recent runs with their result, one failed. */
export function WorkflowRunsExample() {
  const step = useExampleStep(workflowRunsExampleRows.length);

  return (
    <div>
      <ExampleCaption>Recent runs</ExampleCaption>
      <ExampleRows>
        {workflowRunsExampleRows.map((run, index) => (
          <ExampleRow key={`${run.title}-${run.when}`} active={step === index}>
            <LetterTile name={run.title} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-gray-900">{run.title}</span>
              <span className="block truncate text-[12px] text-gray-500">{run.when}</span>
            </span>
            <span className={`shrink-0 text-[13px] ${run.status === "failed" ? "text-[var(--ow-danger)]" : "text-[var(--dls-text-secondary)]"}`}>
              {run.status === "succeeded" ? "Succeeded" : "Failed"}
            </span>
          </ExampleRow>
        ))}
      </ExampleRows>
    </div>
  );
}
