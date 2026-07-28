/** @jsxImportSource react */
import { CheckCircle2, Circle } from "lucide-react";

import type { EnablementCondition, EnablementResult } from "@/app/extensions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ExtensionRequirementListProps = {
  results: EnablementResult[];
  onRun?: (condition: EnablementCondition) => void;
  runLabel?: string;
  className?: string;
};

/** Renders enablement conditions with met/unmet state and optional action. */
export function ExtensionRequirementList({
  results,
  onRun,
  runLabel = "Fix",
  className,
}: ExtensionRequirementListProps) {
  if (results.length === 0) return null;

  return (
    <ul className={cn("space-y-2", className)}>
      {results.map((result) => {
        const Icon = result.met ? CheckCircle2 : Circle;
        return (
          <li
            key={`${result.condition.type}:${result.condition.ref}`}
            className="flex items-center justify-between gap-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Icon
                size={14}
                className={result.met ? "shrink-0 text-green-11" : "shrink-0 text-dls-secondary"}
              />
              <span className={cn("truncate text-sm", result.met ? "text-dls-text" : "text-dls-secondary")}>
                {result.condition.label}
              </span>
            </div>
            {!result.met && onRun ? (
              <Button size="sm" variant="outline" onClick={() => onRun(result.condition)}>
                {runLabel}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
