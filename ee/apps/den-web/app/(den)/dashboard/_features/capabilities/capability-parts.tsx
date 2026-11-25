"use client";

import { DenChip } from "../../../_components/ui/chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../_components/ui/tooltip";

export function ExplainedState({ label, detail, testId }: { label: string; detail: string; testId: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" />} data-testid={testId} className="cursor-default rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-gray-400">
        <DenChip>{label}</DenChip>
        <span className="sr-only">{`: ${detail}`}</span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}
