import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import fuzzysort from "fuzzysort";
import { Blocks, Check, Minus, MoreHorizontal, Plus, RefreshCw, Share2 } from "lucide-react";
import { DenApiError } from "@/app/lib/den";
import type { BuiltMcpAppCatalogEntry } from "@/app/lib/built-mcp-app-catalog";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAppsClient } from "../apps/use-apps";
import { BuiltAppShareDialog } from "../apps/built-app-share-button";
import { McpAppTile, type DashboardLaunchEndpoint } from "./mcp-app-tile";
import { DashboardMasonry } from "./dashboard-masonry";
import { dashboardTileCacheScopeKey } from "./dashboard-tile-cache";
import { mcpAppIdSchema } from "@openwork/types/mcp-app";

export function builtDashboardScope(
  scope: ReturnType<typeof useAppsClient>["scope"],
) {
  return `openwork:personal-mcp-apps:v1:${JSON.stringify(scope)}`;
}

export function readBuiltDashboardApps(scope: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(scope) ?? "[]",
    );
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (id): id is string => mcpAppIdSchema.safeParse(id).success,
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

export function useBuiltDashboardApps() {
  const context = useAppsClient();
  const key = builtDashboardScope(context.scope);
  const [placement, setPlacement] = useState<{ key: string; ids: string[] }>(
    () => ({ key, ids: readBuiltDashboardApps(key) }),
  );
  const ids =
    placement.key === key ? placement.ids : readBuiltDashboardApps(key);
  const currentPlacement = useRef({ key, ids });
  currentPlacement.current = { key, ids };
  useEffect(() => {
    setPlacement({ key, ids: readBuiltDashboardApps(key) });
  }, [key]);
  const query = useQuery({
    queryKey: ["built-dashboard-apps", ...context.scope],
    enabled: Boolean(
      context.client && context.orgId && context.identityVerified,
    ),
    queryFn: async () => {
      if (!context.client || !context.orgId)
        throw new Error("Sign in to browse artifacts.");
      try {
        return await context.client.listBuiltMcpApps(context.orgId);
      } catch (error) {
        // Older deployments did not have a member-accessible App catalog.
        if (
          error instanceof DenApiError &&
          (error.status === 404 || error.status === 403)
        )
          return null;
        throw error;
      }
    },
    staleTime: 15_000,
  });
  const apps = context.identityVerified ? (query.data ?? []) : [];
  return {
    ...context,
    query,
    apps,
    ids,
    ready: context.identityVerified && query.isSuccess && query.data !== null,
    cacheScopeKey: `${dashboardTileCacheScopeKey(context.scope[1] ?? null, context.orgId ?? null)}.built.${JSON.stringify(context.scope)}`,
    setAdded: (appId: string, added: boolean) => {
      if (
        !context.identityVerified ||
        !apps.some((app) => app.connectionId === appId)
      )
        return;
      const current = currentPlacement.current.key === key ? currentPlacement.current.ids : readBuiltDashboardApps(key);
      const next = added
        ? [...new Set([...current, appId])]
        : current.filter((id) => id !== appId);
      setPlacement({ key, ids: next });
      currentPlacement.current = { key, ids: next };
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* In-memory placement remains usable. */
      }
    },
  };
}

export type BuiltDashboardApps = ReturnType<typeof useBuiltDashboardApps>;

export function BuiltAppPicker({
  built,
  onAdded,
}: {
  built: BuiltDashboardApps;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState("");
  const matching = useMemo(
    () =>
      search.trim()
        ? fuzzysort
            .go(search, built.apps, {
              keys: ["title", "description", "pluginName"],
            })
            .map((result) => result.obj)
        : built.apps,
    [built.apps, search],
  );
  return (
    <Command
      items={matching}
      filter={null}
      value={search}
      onValueChange={setSearch}
    >
      <CommandInput
        aria-label="Search artifacts"
        placeholder="Search artifacts by name or tool"
        className="h-14 border-b! pr-10"
      />
      <p className="px-4 pt-3 text-xs text-muted-foreground">{search.trim() ? "Matches" : "Artifacts available to you"} <span className="ml-1 tabular-nums">{matching.length}</span></p>
      <CommandEmpty>No artifacts match your search.</CommandEmpty>
      <CommandList>
        {(app: BuiltMcpAppCatalogEntry) => (
          <CommandItem
            key={app.connectionId}
            value={app}
            aria-label={`Add ${app.title}`}
            disabled={built.ids.includes(app.connectionId)}
            onClick={() => {
              built.setAdded(app.connectionId, true);
              toast(`Added ${app.title}`, { id: "personal-dashboard-placement", action: { label: "Undo", onClick: () => built.setAdded(app.connectionId, false) } });
              onAdded();
            }}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background"><Blocks className="size-4 text-muted-foreground" /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{app.title}</span><span className="block truncate text-xs text-muted-foreground">{app.pluginName}</span></span>
            <span className="text-xs text-muted-foreground">
              {built.ids.includes(app.connectionId) ? (
                <Check className="size-4" aria-label="Added" />
              ) : (
                "Add"
              )}
            </span>
          </CommandItem>
        )}
      </CommandList>
      <div className="flex justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground"><span>Only artifacts you can open show here.</span><span aria-hidden="true">↑↓ to move · ↵ to add</span></div>
    </Command>
  );
}

export function BuiltDashboardTiles({
  built,
  fallbackEndpoints,
  onAdd,
}: {
  built: BuiltDashboardApps;
  fallbackEndpoints?: DashboardLaunchEndpoint[];
  onAdd?: () => void;
}) {
  const personal = built.apps.filter((app) =>
    built.ids.includes(app.connectionId),
  );
  if (built.query.isPending && built.identityVerified)
    return <Skeleton className="mb-4 h-12 w-full" />;
  if (built.query.isError)
    return (
      <div className="mb-4 flex items-center gap-2">
        <p role="alert" className="text-sm">
          Shared artifacts could not be loaded.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void built.query.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  if (!personal.length) return null;
  return (
    <section className="mb-8" aria-label="Artifacts added by you">
      <DashboardMasonry>
        {personal.map((app) => (
          <McpAppTile
            key={app.connectionId}
            cacheScopeKey={built.cacheScopeKey}
            fallbackEndpoints={fallbackEndpoints}
            entry={{
              ...app,
              kind: "mcp",
              id: `personal:${app.connectionId}`,
              launchArguments: { input: {} },
              autoLaunch: true,
            }}
            renderActions={({ onRefresh, refreshing, badge }) => (
              <BuiltDashboardTileMenu
                app={app}
                badge={badge}
                onRefresh={onRefresh}
                refreshing={refreshing}
                onRemove={() => {
                  built.setAdded(app.connectionId, false);
                  toast(`Removed ${app.title}`, { id: "personal-dashboard-placement", action: { label: "Undo", onClick: () => built.setAdded(app.connectionId, true) } });
                }}
              />
            )}
          />
        ))}
        {onAdd ? <button type="button" onClick={onAdd} className="flex min-h-64 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-sm text-muted-foreground hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"><Plus className="size-5" />Add an artifact{built.apps.length > personal.length ? <span className="text-xs">{built.apps.length - personal.length} more available to you</span> : null}</button> : null}
      </DashboardMasonry>
    </section>
  );
}

/** Same discreet hover menu as company dashboard tiles; sharing lives inside it. */
function BuiltDashboardTileMenu({
  app,
  badge,
  onRefresh,
  refreshing,
  onRemove,
}: {
  app: BuiltMcpAppCatalogEntry;
  badge?: ReactNode;
  onRefresh?: () => void;
  refreshing: boolean;
  onRemove: () => void;
}) {
  const [sharing, setSharing] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-7 bg-background/90" aria-label={`Artifact options for ${app.title}`} title={`Artifact options for ${app.title}`} />}>
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              <span className="block">{app.title}</span>
              {badge}
            </DropdownMenuLabel>
            {onRefresh ? <DropdownMenuItem disabled={refreshing} aria-label={`Refresh ${app.title}`} onClick={onRefresh}><RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />Refresh</DropdownMenuItem> : null}
            <DropdownMenuItem aria-label={`Share ${app.title}`} onClick={() => setSharing(true)}><Share2 className="size-4" />Share</DropdownMenuItem>
            <DropdownMenuItem aria-label={`Remove ${app.title} from dashboard`} onClick={onRemove}><Minus className="size-4" />Remove from dashboard</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <BuiltAppShareDialog pluginId={app.pluginId} title={app.title} open={sharing} onOpenChange={setSharing} />
    </>
  );
}
