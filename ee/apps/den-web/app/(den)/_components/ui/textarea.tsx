"use client";

import type { TextareaHTMLAttributes } from "react";

export type DenTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "disabled"
> & {
  /**
   * Number of visible text lines — sets the initial height.
   * Defaults to 4.
   */
  rows?: number;
  /**
   * Disables the textarea and dims it to 60 % opacity.
   * Forwarded as the native `disabled` attribute.
   */
  disabled?: boolean;
};

/**
 * DenTextarea
 *
 * Matches DenInput styling exactly: same border, bg, focus ring,
 * placeholder, and disabled state. Height is controlled by `rows`.
 */
export function DenTextarea({
  rows = 4,
  disabled = false,
  className,
  ...rest
}: DenTextareaProps) {
  return (
    <textarea
      {...rest}
      rows={rows}
      disabled={disabled}
      className={[
        "w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[var(--dls-surface)]",
        "px-4 py-2.5 text-[14px] text-gray-900 dark:text-gray-100",
        "outline-none transition-all placeholder:text-gray-400 dark:text-gray-500",
        "focus:border-gray-300 dark:focus:border-gray-600 dark:border-gray-600 focus:ring-2 focus:ring-gray-900/5 dark:focus:ring-gray-100/10",
        "resize-none",
        disabled ? "cursor-not-allowed opacity-60" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
