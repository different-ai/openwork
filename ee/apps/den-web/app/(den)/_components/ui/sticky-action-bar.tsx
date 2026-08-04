"use client";

import type { ReactNode } from "react";

export type DenStickyActionBarProps = {
  /** Live summary of what will be saved (icon + name, counts, access). */
  summary?: ReactNode;
  /** Action buttons, rendered on the right. */
  children: ReactNode;
  testId?: string;
};

/**
 * A save bar that sticks to the bottom of the viewport while the page
 * scrolls, so long forms never require scrolling back up to save.
 */
export function DenStickyActionBar({ summary, children, testId }: DenStickyActionBarProps) {
  return (
    <div data-testid={testId} className="sticky bottom-4 z-20 mt-8">
      <div className="flex items-center gap-4 rounded-[20px] border border-gray-200 bg-white py-3 pl-5 pr-3 shadow-[0_12px_40px_-12px_rgba(15,23,42,0.28)]">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-gray-600">{summary}</div>
        <div className="flex shrink-0 items-center gap-3">{children}</div>
      </div>
    </div>
  );
}
