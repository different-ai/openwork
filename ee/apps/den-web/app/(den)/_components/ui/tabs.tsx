"use client";

import { Tabs } from "@base-ui/react/tabs";
import type { ComponentProps, ElementType, ReactNode } from "react";
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
  label?: string;
  children?: ReactNode;
  /** Keeps empty tabs honest: shows "0" instead of hiding the count. */
  showZeroCounts?: boolean;
};

/** Shared appearance for Den's tab buttons and route-based tab links. */
export function underlineTabClassName(selected: boolean) {
  return `inline-flex items-center gap-2 border-b-2 pb-3 text-[14px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-accent)] ${selected ? "border-[var(--dls-accent)] text-[var(--dls-text-primary)]" : "border-transparent text-[var(--dls-text-secondary)] hover:text-[var(--dls-text-primary)]"}`;
}

/** Base UI owns roving focus, arrow/Home/End keys, activation and panel associations. */
export function UnderlineTabs<T extends string>({ tabs, activeTab, onChange, className = "", label = "Sections", showZeroCounts = false, children }: UnderlineTabsProps<T>) {
  return <Tabs.Root value={activeTab} onValueChange={(value) => { const tab = tabs.find((entry) => entry.value === value); if (tab) onChange(tab.value); }}>
    <div className={`border-b border-gray-200 ${className}`}>
      <Tabs.List activateOnFocus className="-mb-px flex flex-wrap gap-6" aria-label={label}>
        {tabs.map(({ value, label: title, icon: Icon, count, countTone = "neutral", countClassName }) => <Tabs.Tab key={value} value={value} className={underlineTabClassName(activeTab === value)}>
          {Icon ? <Icon className="size-4" aria-hidden /> : null}
          {title}
          {count !== undefined && (count > 0 || showZeroCounts) ? <DenChip tone={countTone} className={`${count === 0 ? "!bg-transparent !text-gray-300" : ""} ${countClassName ?? ""}`}>{count}</DenChip> : null}
        </Tabs.Tab>)}
      </Tabs.List>
    </div>
    {children}
  </Tabs.Root>;
}

/** Retain scoped drafts, while inactive panels are hidden, inert and out of the tab order. */
export function UnderlineTabPanel(props: ComponentProps<typeof Tabs.Panel>) {
  return <Tabs.Panel {...props} keepMounted />;
}
