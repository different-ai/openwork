"use client";

import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../_components/ui/tooltip";

/** An "i" beside a setting's label: one or two sentences on what the setting does, on hover or keyboard focus. */
export function HelpTip({ label, children }: { label: string; children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" />}
        aria-label={`About ${label}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-500 outline-hidden hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        <Info size={14} strokeWidth={1.5} aria-hidden="true" />
        <span className="sr-only">{`: ${children}`}</span>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}
