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
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-xs font-medium text-[var(--dls-text-secondary)]" htmlFor={FILTER_INPUT_ID}>
        Project
      </label>
      <DenSelect
        id={FILTER_INPUT_ID}
        aria-label="Project analytics filter"
        size="sm"
        className="w-56 max-w-full"
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
        <span className="text-[12px] text-[var(--dls-text-secondary)]">
          {activeOption.sessionCount} {activeOption.sessionCount === 1 ? "session" : "sessions"}
        </span>
      ) : null}
    </div>
  );
}
