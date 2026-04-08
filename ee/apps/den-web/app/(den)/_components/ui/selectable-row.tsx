"use client";

import { Check } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type DenSelectableRowProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> & {
  title: ReactNode;
  description?: ReactNode;
  selected?: boolean;
  aside?: ReactNode;
  leading?: ReactNode;
  descriptionBelow?: boolean;
};

export function DenSelectableRow({
  title,
  description,
  selected = false,
  disabled = false,
  aside,
  leading,
  descriptionBelow = false,
  className,
  ...rest
}: DenSelectableRowProps) {
  return (
    <button
      {...rest}
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      className={[
        "group relative flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150",
        "focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-gray-900/5",
        selected
          ? "bg-gray-100"
          : "bg-white hover:bg-gray-50/60",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}

      <div className="min-w-0 flex-1">
        <div className={descriptionBelow ? "grid min-w-0 gap-0.5" : "flex min-w-0 items-baseline gap-2"}>
          <p className="truncate text-[15px] font-medium leading-[1.15] tracking-[-0.02em] text-gray-950">{title}</p>
          {description ? <p className="truncate text-[12px] leading-[1.15] text-gray-500">{description}</p> : null}
        </div>
      </div>

      {aside ? <div className="shrink-0">{aside}</div> : null}

      {selected ? (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-emerald-700 text-white" aria-hidden="true">
          <Check className="h-3 w-3" />
        </span>
      ) : (
        <span className="h-5 w-5 shrink-0 rounded-[5px] border border-gray-300 bg-white transition-colors group-hover:border-gray-400" aria-hidden="true" />
      )}
    </button>
  );
}
