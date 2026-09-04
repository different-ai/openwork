/** @jsxImportSource react */
import { SearchIcon } from "lucide-react";

import { isWebDeployment } from "../../app/lib/openwork-deployment";
import { CommandShortcut } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { usePlatform } from "../kernel/platform";
import { openCommandPalette } from "./command-palette-bus";
import { resolveSessionNumberShortcutOs } from "./session-number-shortcuts";

export function CommandPaletteSearchBar({ className }: { className?: string }) {
  const platform = usePlatform();
  const os = resolveSessionNumberShortcutOs(
    platform.os,
    typeof navigator === "undefined" ? "" : navigator.platform,
  );

  if (!isWebDeployment()) return null;

  const isMac = os === "macos";

  return (
    <button
      type="button"
      data-testid="command-palette-search-bar"
      aria-label="Search or jump to"
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      className={cn(
        "inline-flex h-7 items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring mac:titlebar-no-drag md:w-full md:max-w-md",
        className,
      )}
      onClick={openCommandPalette}
    >
      <SearchIcon size={14} />
      <span className="hidden truncate md:inline">Search or jump to…</span>
      <CommandShortcut className="hidden md:inline">{isMac ? "⌘K" : "Ctrl K"}</CommandShortcut>
    </button>
  );
}
