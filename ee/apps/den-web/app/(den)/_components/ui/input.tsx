"use client";

import type { ElementType, InputHTMLAttributes } from "react";

export type DenInputProps = InputHTMLAttributes<HTMLInputElement> & {
  /**
   * Optional Lucide icon component rendered on the left.
   * When omitted the input renders with no icon and no extra left padding.
   */
  icon?: ElementType<{ size?: number; className?: string }>;
  /**
   * Pixel size of the icon. Defaults to 16.
   * Use 20 for taller inputs (h-14 / h-16) so the icon is proportional.
   * The component automatically selects the correct left position and
   * default left-padding based on this value — no need to pass `pl-*`
   * unless you want to override.
   */
  iconSize?: number;
};

/**
 * DenInput
 *
 * Consistent text input for all dashboard pages.
 * Based on the Shared Workspaces compact search field.
 *
 * Usage:
 *   // with icon
 *   <DenInput icon={Search} placeholder="Search…" className="rounded-lg py-2 pr-4 text-[13px]" />
 *
 *   // without icon (form field)
 *   <DenInput type="email" className="h-14 rounded-[20px] px-4 text-[15px] bg-[#f8fafc]" />
 *
 * The component sets border, bg, text, placeholder, focus-ring, outline and
 * disabled states. Pass `className` for sizing, rounding, and bg overrides.
 */
export function DenInput({
  icon: Icon,
  iconSize = 16,
  className = "",
  ...rest
}: DenInputProps) {
  const isLarge = iconSize > 16;
  // position and padding are derived from iconSize so callers don't have to
  const iconLeftClass = isLarge ? "left-5" : "left-3";
  const defaultPl = Icon ? (isLarge ? "pl-14" : "pl-9") : "";
  // skip default pl if the caller already specified one
  const pl = className.includes("pl-") ? "" : defaultPl;

  const input = (
    <input
      {...rest}
      className={[
        "w-full border border-gray-200 bg-white text-gray-900 outline-none",
        "transition-all placeholder:text-gray-400",
        "focus:border-gray-300 focus:ring-2 focus:ring-gray-900/5",
        "disabled:cursor-not-allowed disabled:opacity-70",
        pl,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );

  if (!Icon) return input;

  return (
    <div className="relative">
      <div
        className={`pointer-events-none absolute inset-y-0 ${iconLeftClass} flex items-center`}
      >
        <Icon size={iconSize} className="text-gray-400" aria-hidden="true" />
      </div>
      {input}
    </div>
  );
}
