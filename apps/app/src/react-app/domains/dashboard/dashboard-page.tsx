/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Blocks, Plus } from "lucide-react";

import { readDenSettings } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { AddAppDialog } from "./add-app-dialog";
import {
  dashboardScopeKey,
  readDashboardEntries,
  writeDashboardEntries,
  type DashboardEntry,
} from "./dashboard-store";
import { HelloWorldTile } from "./hello-world-tile";
import { McpAppTile, type DashboardLaunchEndpoint } from "./mcp-app-tile";

/**
 * The per-user MCP Apps dashboard: a session-independent grid of app tiles.
 * Entries persist locally per signed-in user and organization, so switching
 * sessions or workspaces never changes the board.
 */
export function DashboardPage({ fallbackEndpoints }: {
  /** Other workspace MCP runtimes tiles may launch through when the primary one lacks their server. */
  fallbackEndpoints?: DashboardLaunchEndpoint[];
} = {}) {
  const denAuth = useDenAuth();
  // The active org lives in den settings, which change outside React; track it
  // through the settings-changed event so an org switch swaps the board scope.
  const [activeOrgId, setActiveOrgId] = useState<string | null>(() => readDenSettings().activeOrgId ?? null);
  useEffect(() => {
    const sync = () => setActiveOrgId(readDenSettings().activeOrgId ?? null);
    window.addEventListener(denSettingsChangedEvent, sync);
    return () => window.removeEventListener(denSettingsChangedEvent, sync);
  }, []);
  const scopeKey = useMemo(
    () => dashboardScopeKey(denAuth.user?.id ?? null, activeOrgId),
    [activeOrgId, denAuth.user?.id],
  );
  // While Den auth is restoring, the board would read the shared signed-out
  // scope and auto-launch its entries against the account about to be
  // restored. Hold the board (and every launch) until the scope is final.
  if (denAuth.status === "checking") {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-6" data-dashboard-page>
        <div className="space-y-2 pt-3" role="status" aria-label="Loading dashboard">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }
  return <DashboardBoard key={scopeKey} scopeKey={scopeKey} fallbackEndpoints={fallbackEndpoints} />;
}

function DashboardBoard({ scopeKey, fallbackEndpoints }: {
  scopeKey: string;
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const [entries, setEntries] = useState<DashboardEntry[]>(() => readDashboardEntries(scopeKey));
  useEffect(() => {
    setEntries(readDashboardEntries(scopeKey));
  }, [scopeKey]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const existingIds = useMemo(() => new Set(entries.map((entry) => entry.id)), [entries]);

  const updateEntries = (next: DashboardEntry[]) => {
    setEntries(next);
    writeDashboardEntries(scopeKey, next);
  };
  const removeEntry = (id: string) => updateEntries(entries.filter((entry) => entry.id !== id));
  const markLaunchApproved = (id: string) => updateEntries(entries.map((entry) => (
    entry.kind === "mcp" && entry.id === id ? { ...entry, launchApproved: true } : entry
  )));
  const markAutoLaunchUnlocked = (id: string) => updateEntries(entries.map((entry) => (
    entry.kind === "mcp" && entry.id === id ? { ...entry, autoLaunch: true } : entry
  )));

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-6" data-dashboard-page>
      <header className="mb-4 flex items-center gap-2">
        <p className="flex-1 text-sm text-muted-foreground">
          Your MCP apps, one click away in every session.
        </p>
        <Button onClick={() => setPickerOpen(true)}>
          <Plus className="size-4" /> Add app
        </Button>
      </header>
      {entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Blocks /></EmptyMedia>
            <EmptyTitle>No apps yet</EmptyTitle>
            <EmptyDescription>
              Add MCP apps available via OpenWork Connect to keep them one click away.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setPickerOpen(true)}>
              <Plus className="size-4" /> Add app
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
          {entries.map((entry) => (
            entry.kind === "builtin-hello" ? (
              <HelloWorldTile key={entry.id} onRemove={() => removeEntry(entry.id)} />
            ) : (
              <McpAppTile
                key={entry.id}
                entry={entry}
                onRemove={() => removeEntry(entry.id)}
                onApprovedLaunch={() => markLaunchApproved(entry.id)}
                onFirstRunCompleted={() => markAutoLaunchUnlocked(entry.id)}
                fallbackEndpoints={fallbackEndpoints}
              />
            )
          ))}
        </div>
      )}
      <AddAppDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        existingIds={existingIds}
        onAdd={(entry) => {
          if (!existingIds.has(entry.id)) updateEntries([...entries, entry]);
        }}
      />
    </div>
  );
}
