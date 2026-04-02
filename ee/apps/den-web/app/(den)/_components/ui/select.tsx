"use client";

import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";

export type DenSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "disabled"> & {
  /**
   * Disables the select and dims it to 60 % opacity.
   * Forwarded as the native `disabled` attribute.
   */
  disabled?: boolean;
};

/**
 * DenSelect
 *
 * Consistent native select for all dashboard pages, matched to the
 * Shared Workspaces compact field sizing used by DenInput.
 *
 * Defaults: rounded-lg · h-[42px] · px-4/pr-10 · text-[14px]/leading-5
 * Chevron: custom Lucide chevron replaces browser-native control chrome.
 * No className needed at the call site - override only when necessary.
 */
export function DenSelect({
  disabled = false,
  className,
  children,
  ...rest
}: DenSelectProps) {
  return (
    <div className="relative">
      <select
        {...rest}
        disabled={disabled}
        className={[
          "w-full appearance-none rounded-lg border border-gray-200 bg-white",
          "h-[42px] px-4 pr-10 text-[14px] leading-5 text-gray-900",
          "outline-none transition-all",
          "focus:border-gray-300 focus:ring-2 focus:ring-gray-900/5",
          disabled ? "cursor-not-allowed opacity-60" : "",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
        <ChevronDown
          size={16}
          className={disabled ? "text-gray-300" : "text-gray-400"}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
