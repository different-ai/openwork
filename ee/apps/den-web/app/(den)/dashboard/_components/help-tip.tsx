"use client";

import { Info } from "lucide-react";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../_components/ui/tooltip";

export function HelpTip({ label, children }: { label: string; children: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        render={<button type="button" />}
        delay={150}
        closeOnClick={false}
        onClick={() => setOpen(true)}
        aria-label={`About ${label}`}
        data-testid="help-tip"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-500 outline-hidden hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        <Info size={14} strokeWidth={1.5} aria-hidden="true" />
        <span className="sr-only">{`: ${children}`}</span>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}
