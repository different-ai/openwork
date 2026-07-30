"use client";

import type { LucideIcon } from "lucide-react";

export type DenToggleRowProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  testId?: string;
  onChange: (checked: boolean) => void;
};

/**
 * A prominent switch row: icon tile, title/description, and a toggle. Used for
 * coarse-grained choices like "Everyone in the organization" access.
 */
export function DenToggleRow({
  icon: Icon,
  title,
  description,
  checked,
  disabled = false,
  testId,
  onChange,
}: DenToggleRowProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center gap-4 rounded-[16px] border px-5 py-4 text-left transition ${
        checked ? "border-gray-900 bg-gray-50" : "border-gray-200 bg-white hover:border-gray-300"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      {Icon ? (
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] ${
            checked ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500"
          }`}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-gray-950">{title}</span>
        {description ? (
          <span className="mt-0.5 block text-[13px] leading-5 text-gray-500">{description}</span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className={`flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? "justify-end bg-gray-900" : "justify-start bg-gray-200"
        }`}
      >
        <span className="h-5 w-5 rounded-full bg-white shadow-sm" />
      </span>
    </button>
  );
}
