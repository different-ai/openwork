/** @jsxImportSource react */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export type TextInputProps = ComponentProps<"input"> & {
  label?: string;
  hint?: string;
};

export function TextInput({ label, hint, className, ref, ...rest }: TextInputProps) {
  return (
    <label className="block">
      {label ? (
        <div className="mb-1 text-xs font-medium text-dls-secondary">
          {label}
        </div>
      ) : null}
      <input
        ref={ref}
        className={cn(
          "w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text shadow-sm placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]",
          className,
        )}
        {...rest}
      />
      {hint ? (
        <div className="mt-1 text-xs text-dls-secondary">{hint}</div>
      ) : null}
    </label>
  );
}
