/** @jsxImportSource react */
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

type DashboardTileShellProps = {
  title: string;
  entryId?: string;
  subtitle?: string;
  badge?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  children: ReactNode;
};

export function DashboardTileShell({ title, entryId, subtitle, badge, onRefresh, refreshing = false, children }: DashboardTileShellProps) {
  return (
    <section
      className="flex min-h-64 flex-col overflow-hidden rounded-xl border border-border bg-background"
      data-dashboard-entry={entryId}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {subtitle ? <span className="truncate text-xs text-muted-foreground">{subtitle}</span> : null}
        </div>
        {badge}
        {onRefresh ? (
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">{children}</div>
    </section>
  );
}
