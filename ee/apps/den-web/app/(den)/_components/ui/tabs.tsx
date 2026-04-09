"use client";

import type { ElementType } from "react";

export type TabItem<T extends string> = {
  value: T;
  label: string;
  icon?: ElementType<{ className?: string }>;
  count?: number;
};

type UnderlineTabsProps<T extends string> = {
  tabs: readonly TabItem<T>[];
  activeTab: T;
  onChange: (value: T) => void;
  className?: string;
};

export function UnderlineTabs<T extends string>({
  tabs,
  activeTab,
  onChange,
  className = "",
}: UnderlineTabsProps<T>) {
  return (
    <div className={`border-b border-gray-200 ${className}`}>
      <nav className="-mb-px flex flex-wrap gap-6" role="tablist">
        {tabs.map(({ value, label, icon: Icon, count }) => {
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
              {count !== undefined && count > 0 ? (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    selected ? "bg-gray-100 text-gray-600" : "bg-gray-100 text-gray-400"
                  }`}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
