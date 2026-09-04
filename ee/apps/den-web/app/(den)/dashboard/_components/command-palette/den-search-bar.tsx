"use client";

import { Search } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export type DenSearchBarHandle = {
  focus: () => void;
};

type DenSearchBarProps = {
  onOpen: () => void;
};

function getUserAgentDataPlatform(): string {
  if (!("userAgentData" in navigator)) return "";
  const userAgentData = navigator.userAgentData;
  if (
    typeof userAgentData !== "object"
    || userAgentData === null
    || !("platform" in userAgentData)
    || typeof userAgentData.platform !== "string"
  ) {
    return "";
  }
  return userAgentData.platform;
}

export const DenSearchBar = forwardRef<DenSearchBarHandle, DenSearchBarProps>(
  function DenSearchBar({ onOpen }, ref) {
    const [isMac, setIsMac] = useState(false);
    const desktopTriggerRef = useRef<HTMLButtonElement>(null);
    const mobileTriggerRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
      const platform = `${getUserAgentDataPlatform()} ${navigator.platform} ${navigator.userAgent}`;
      setIsMac(/Mac|iPhone|iPad|iPod/i.test(platform));
    }, []);

    useImperativeHandle(ref, () => ({
      focus() {
        const desktop = window.matchMedia("(min-width: 768px)").matches;
        (desktop ? desktopTriggerRef.current : mobileTriggerRef.current)?.focus();
      },
    }), []);

    return (
      <>
        <button
          ref={desktopTriggerRef}
          type="button"
          data-testid="den-command-palette-trigger"
          aria-label="Search or jump to"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={onOpen}
          className="hidden h-9 w-[min(420px,100%)] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 text-[13px] text-gray-400 shadow-sm transition-colors hover:border-gray-300 hover:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900/5 md:flex"
        >
          <Search className="h-4 w-4 shrink-0" strokeWidth={1.8} />
          <span className="truncate">Search or jump to…</span>
          <kbd className="ml-auto rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-sans text-[11px] text-gray-500">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
        <button
          ref={mobileTriggerRef}
          type="button"
          data-testid="den-command-palette-trigger"
          aria-label="Search or jump to"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={onOpen}
          className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900/5 md:hidden"
        >
          <Search className="h-5 w-5" strokeWidth={1.8} />
        </button>
      </>
    );
  },
);
