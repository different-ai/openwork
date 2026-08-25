/** @jsxImportSource react */
import type { ReactNode } from "react";
import { RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";

type DashboardTileShellProps = {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  onRefresh?: () => void;
  onRemove: () => void;
  children: ReactNode;
};

export function DashboardTileShell({ title, subtitle, badge, onRefresh, onRemove, children }: DashboardTileShellProps) {
  return (
    <section className="flex min-h-64 flex-col overflow-hidden rounded-xl border border-border bg-background">
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {subtitle ? <span className="truncate text-xs text-muted-foreground">{subtitle}</span> : null}
        </div>
        {badge}
        {onRefresh ? (
          <Button variant="ghost" size="icon" aria-label={`Refresh ${title}`} title="Refresh" onClick={onRefresh}>
            <RefreshCw className="size-4" />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" aria-label={`Remove ${title}`} title="Remove" onClick={onRemove}>
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">{children}</div>
    </section>
  );
}
