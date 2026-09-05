"use client";

import type { TelemetryDimensionListItem } from "@openwork-ee/telemetry-contracts";
import { DenSelect } from "../../../_components/ui/select";

const FILTER_INPUT_ID = "analytics-project-filter";

/**
 * Narrows the analytics screen to one project dimension. An empty value means
 * "All projects"; when a project is chosen its recorded session count is
 * shown next to the select.
 */
export function ProjectFilter({ options, value, onValueChange }: {
  options: TelemetryDimensionListItem[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const activeOption = value ? options.find((option) => option.value === value) ?? null : null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <label className="text-[12px] font-semibold uppercase text-[#637291]" htmlFor={FILTER_INPUT_ID}>
        Project
      </label>
      <DenSelect
        id={FILTER_INPUT_ID}
        aria-label="Project analytics filter"
        className="h-9 min-w-[240px]"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="">All projects</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </DenSelect>
      {activeOption ? (
        <span className="text-[12px] text-[#637291]">
          {activeOption.sessionCount} {activeOption.sessionCount === 1 ? "session" : "sessions"}
        </span>
      ) : null}
    </div>
  );
}
