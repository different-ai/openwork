"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ElementType } from "react";
import { DenChip, type DenChipTone } from "./chip";

export type TabItem<T extends string> = {
  value: T;
  label: string;
  icon?: ElementType<{ className?: string }>;
  count?: number;
  countTone?: DenChipTone;
  countClassName?: string;
  unseen?: boolean;
};

type UnderlineTabsProps<T extends string> = {
  tabs: readonly TabItem<T>[];
  activeTab: T;
  onChange: (value: T) => void;
  className?: string;
  showZeroCounts?: boolean;
};

export function UnseenDot() {
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-gray-400"
      role="img"
      aria-label="Not viewed yet"
      title="Not viewed yet"
      data-testid="unseen-dot"
    />
  );
}

export function underlineTabClassName(selected: boolean) {
  return `inline-flex items-center gap-2 border-b-2 pb-3 text-[14px] font-medium transition-colors ${selected ? "border-[var(--dls-accent)] text-[var(--dls-text-primary)]" : "border-transparent text-[var(--dls-text-secondary)] hover:text-[var(--dls-text-primary)]"}`;
}

const TAB_PEEK = 56;

const TAB_FADE = {
  start: "[mask-image:linear-gradient(to_right,transparent_24px,black_56px)]",
  end: "[mask-image:linear-gradient(to_left,transparent_24px,black_56px)]",
  both: "[mask-image:linear-gradient(to_right,transparent_24px,black_56px,black_calc(100%_-_56px),transparent_calc(100%_-_24px))]",
};

const scrollButtonClass = "absolute top-0 flex h-5 w-6 items-center text-gray-500 hover:text-gray-900";

export function UnderlineTabs<T extends string>({
  tabs,
  activeTab,
  onChange,
  className = "",
  showZeroCounts = false,
}: UnderlineTabsProps<T>) {
  const listRef = useRef<HTMLElement>(null);
  const shown = useRef(false);
  const [hidden, setHidden] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const start = list.scrollLeft > 1;
    const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
    setHidden((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  useEffect(measure);

  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !tab) return;
    const row = list.getBoundingClientRect();
    const chosen = tab.getBoundingClientRect();
    const before = row.left + TAB_PEEK - chosen.left;
    const after = chosen.right - (row.right - TAB_PEEK);
    const move = before > 0 ? -before : after > 0 ? after : 0;
    if (move !== 0) list.scrollTo({ left: list.scrollLeft + move, behavior: shown.current ? "auto" : "instant" });
    shown.current = true;
  }, [activeTab]);

  const scrollTabs = (direction: -1 | 1) => {
    const list = listRef.current;
    if (list) list.scrollBy({ left: direction * Math.max(120, list.clientWidth * 0.6) });
  };
  const fade = hidden.start && hidden.end ? TAB_FADE.both : hidden.start ? TAB_FADE.start : hidden.end ? TAB_FADE.end : "";

  return (
    <div className={`relative border-b border-gray-200 ${className}`}>
      <nav
        ref={listRef}
        className={`-mx-1 -mb-px -mt-1 flex gap-6 overflow-x-auto overflow-y-hidden scroll-smooth px-1 pt-1 [scrollbar-width:none] motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden ${fade}`}
        role="tablist"
      >
        {tabs.map(({ value, label, icon: Icon, count, countTone = "neutral", countClassName, unseen }) => {
          const selected = activeTab === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(value)}
              className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 pb-3 text-[14px] font-medium transition-colors ${
                selected
                  ? "border-[#0f172a] text-[#0f172a]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
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
              {unseen && !selected ? <UnseenDot /> : null}
            </button>
          );
        })}
      </nav>
      {hidden.start ? (
        <button type="button" tabIndex={-1} aria-label="Show earlier tabs" className={`${scrollButtonClass} left-0 justify-start`} onClick={() => scrollTabs(-1)} data-testid="tabs-scroll-start">
          <ChevronLeft className="h-4 w-4" />
        </button>
      ) : null}
      {hidden.end ? (
        <button type="button" tabIndex={-1} aria-label="Show more tabs" className={`${scrollButtonClass} right-0 justify-end`} onClick={() => scrollTabs(1)} data-testid="tabs-scroll-end">
          <ChevronRight className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
