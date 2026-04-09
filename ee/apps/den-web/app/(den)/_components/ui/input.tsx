"use client";

import type { ElementType, InputHTMLAttributes } from "react";

export type DenInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "disabled"> & {
  /**
   * Optional Lucide icon component rendered on the left.
   * When omitted, no icon is shown and no extra left padding is added.
   */
  icon?: ElementType<{ size?: number; className?: string }>;
  /**
   * Pixel size of the icon. Defaults to 16.
   * Use 20 for larger search fields so the icon stays proportional.
   * Left position and left-padding are derived automatically.
   */
  iconSize?: number;
  /**
   * Disables the input and dims it to 60 % opacity.
   * Forwarded as the native `disabled` attribute.
   */
  disabled?: boolean;
};

/**
 * DenInput
 *
 * Consistent text input for all dashboard pages, based on the
 * Shared Workspaces compact search field.
 *
 * Defaults: rounded-lg · h-[42px] · px-4 · text-[14px]/leading-5
 * Icon: auto-positions and adjusts left padding.
 * No className needed at the call site — override only when necessary.
 */
export function DenInput({
  icon: Icon,
  iconSize = 16,
  disabled = false,
  className,
  ...rest
}: DenInputProps) {
  const isLargeIcon = iconSize > 16;
  const iconLeft = isLargeIcon ? "left-5" : "left-3";
  // inject icon left-padding only if the caller hasn't specified one
  const iconPl = Icon
    ? className?.includes("pl-")
      ? ""
      : isLargeIcon
        ? "pl-14"
        : "pl-9"
    : "";

  const input = (
    <input
      {...rest}
      disabled={disabled}
      className={[
        // base visual style
        "w-full rounded-lg border border-gray-200 bg-white",
        "h-[42px] px-4 text-[14px] leading-5 text-gray-900",
        "outline-none transition-all placeholder:text-gray-400",
        "focus:border-gray-300 focus:ring-2 focus:ring-gray-900/5",
        // disabled state
        disabled ? "cursor-not-allowed opacity-60" : "",
        // icon left-padding (overrides px-4 left side)
        iconPl,
        // caller overrides
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );

  if (!Icon) return input;

  return (
    <div className="relative">
      <div
        className={`pointer-events-none absolute inset-y-0 ${iconLeft} flex items-center`}
      >
        <Icon
          size={iconSize}
          className={disabled ? "text-gray-300" : "text-gray-400"}
          aria-hidden="true"
        />
      </div>
      {input}
    </div>
  );
}
