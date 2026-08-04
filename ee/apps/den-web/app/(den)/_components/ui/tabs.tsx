"use client";

import type { ElementType } from "react";
import { DenChip, type DenChipTone } from "./chip";

export type TabItem<T extends string> = {
  value: T;
  label: string;
  icon?: ElementType<{ className?: string }>;
  count?: number;
  countTone?: DenChipTone;
  countClassName?: string;
};

type UnderlineTabsProps<T extends string> = {
  tabs: readonly TabItem<T>[];
  activeTab: T;
  onChange: (value: T) => void;
  className?: string;
  /** Keeps empty tabs honest: shows "0" instead of hiding the count. */
  showZeroCounts?: boolean;
};

export function UnderlineTabs<T extends string>({
  tabs,
  activeTab,
  onChange,
  className = "",
  showZeroCounts = false,
}: UnderlineTabsProps<T>) {
  return (
    <div className={`border-b border-gray-200 ${className}`}>
      <nav className="-mb-px flex flex-wrap gap-6" role="tablist">
        {tabs.map(({ value, label, icon: Icon, count, countTone = "neutral", countClassName }) => {
          const selected = activeTab === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(value)}
              className={`inline-flex items-center gap-2 border-b-2 pb-3 text-[14px] font-medium transition-colors ${
                selected
                  ? "border-[#0f172a] text-[#0f172a]"
                  : "border-transparent text-gray-400 hover:text-gray-600"
              }`}
            >
              {Icon ? <Icon className="h-4 w-4" /> : null}
              {label}
              {count !== undefined && (count > 0 || showZeroCounts) ? (
                <DenChip
                  tone={countTone}
                  className={`${count === 0 ? "!bg-transparent !text-gray-300" : ""} ${countClassName ?? ""}`}
                >
                  {count}
                </DenChip>
              ) : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
