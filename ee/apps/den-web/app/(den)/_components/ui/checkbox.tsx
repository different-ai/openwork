"use client";

import { Checkbox } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";

export type DenCheckboxProps = Omit<Checkbox.Root.Props, "className"> & {
  className?: string;
};

/** Shared checkbox with Base UI keyboard, label and native form semantics. */
export function DenCheckbox({ className, ...props }: DenCheckboxProps) {
  return (
    <Checkbox.Root
      {...props}
      data-slot="checkbox"
      className={[
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-gray-300 bg-white text-gray-900",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900",
        "data-checked:border-gray-900 data-checked:bg-gray-900 data-checked:text-white",
        "data-disabled:cursor-not-allowed data-disabled:opacity-60 aria-invalid:border-red-600",
        className,
      ].filter(Boolean).join(" ")}
    >
      <Checkbox.Indicator className="flex items-center justify-center">
        <Check size={12} strokeWidth={1.5} aria-hidden />
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}
