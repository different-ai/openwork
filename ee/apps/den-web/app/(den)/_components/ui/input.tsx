"use client";

import type { ElementType, InputHTMLAttributes } from "react";

export type DenInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "disabled"> & {
  icon?: ElementType<{ size?: number; className?: string }>;
  iconSize?: number;
  disabled?: boolean;
};

export function DenInput({
  icon: Icon,
  iconSize = 16,
  disabled = false,
  className,
  ...rest
}: DenInputProps) {
  const isLargeIcon = iconSize > 16;
  const iconLeft = isLargeIcon ? "left-5" : "left-3";
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
        "w-full rounded-lg border border-gray-200 bg-white",
        "h-[42px] px-4 text-[14px] leading-5 text-gray-900",
        "outline-hidden transition-all placeholder:text-gray-400",
        "focus:border-gray-300 focus:ring-2 focus:ring-gray-900/5",
        disabled ? "cursor-not-allowed opacity-60" : "",
        iconPl,
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
