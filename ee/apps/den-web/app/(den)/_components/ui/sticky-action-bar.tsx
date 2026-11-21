"use client";

import type { ReactNode } from "react";

export type DenStickyActionBarProps = {
  summary?: ReactNode;
  children: ReactNode;
  sticky?: boolean;
  testId?: string;
};

export function DenStickyActionBar({ summary, children, sticky = true, testId }: DenStickyActionBarProps) {
  return (
    <div
      data-testid={testId}
      data-den-action-bar={sticky ? "sticky" : "inline"}
      className={sticky ? "sticky bottom-0 z-20 mt-8 bg-[var(--den-shell-canvas)] pb-4 pt-3" : "mt-8"}
    >
      <div className="flex items-center gap-4 rounded-[20px] border border-gray-200 bg-white py-3 pl-5 pr-3 shadow-[0_12px_40px_-12px_rgba(15,23,42,0.28)]">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-gray-600">{summary}</div>
        <div className="flex shrink-0 items-center gap-3">{children}</div>
      </div>
    </div>
  );
}
