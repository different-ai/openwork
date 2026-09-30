/** @jsxImportSource react */
import type { ReactNode } from "react";
import { MoreHorizontal, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type DashboardTileActions = (props: { onRefresh?: () => void; refreshing: boolean; badge?: ReactNode }) => ReactNode;

type DashboardTileShellProps = {
  renderActions?: DashboardTileActions;
  title: string;
  entryId?: string;
  subtitle?: string;
  badge?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** A healthy App supplies its own visual shell; keep host actions out of its layout. */
  compact?: boolean;
  children: ReactNode;
};

export function DashboardTileShell({ title, entryId, subtitle, badge, onRefresh, refreshing = false, compact = false, renderActions, children }: DashboardTileShellProps) {
  return (
    <section
      className={compact
        ? "group/tile relative min-w-0"
        : "relative flex min-h-64 flex-col overflow-hidden rounded-xl border border-border bg-background"}
      data-dashboard-entry={entryId}
      aria-label={title}
    >
      {!compact ? (
        <header className={cn("flex items-center gap-2 border-b border-border px-3 py-1.5", renderActions && "pr-12")}>
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
            {subtitle ? <span className="truncate text-xs text-muted-foreground">{subtitle}</span> : null}
          </div>
          {badge}
          {onRefresh && !renderActions ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Refresh ${title}`}
              title="Refresh"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
          ) : null}
        </header>
      ) : null}
      {/* Keep this parent stable: changing recovery chrome must not remount a live iframe. */}
      <div className={compact ? "min-w-0" : "flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3"}>{children}</div>
      {renderActions || (compact && onRefresh) ? (
        <div className={cn("absolute right-1 top-1 z-10", compact && "opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tile:opacity-100 focus-within:opacity-100")}>
          {renderActions ? renderActions({ onRefresh, refreshing, badge }) : <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-7 bg-background/90" aria-label={`App options for ${title}`} title={`App options for ${title}`} />}>
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  <span className="block">{title}</span>
                  {badge}
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={onRefresh} disabled={refreshing} aria-label={`Refresh ${title}`}>
                  <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>}
        </div>
      ) : null}
    </section>
  );
}
