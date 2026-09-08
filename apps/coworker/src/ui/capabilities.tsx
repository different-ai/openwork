import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import {
  APPS_TOOLS_CRUMBS,
  appPath,
  appsForServer,
  appsToolsScreen,
  catalogApps,
  connectionPath,
  humanizeToolName,
  isPersonalTool,
  pathForTool,
  pluginPath,
  searchItems,
  searchScope,
  skillPath,
  toolIdsForServer,
  toolPath,
  type CatalogApp,
  type SearchableItem,
  type SearchGroup,
} from "@/lib/apps-tools";
import { CONNECT_MCP_NAME, type ConnectState } from "@/lib/connect";
import {
  buildConnectCatalog,
  CONNECT_SEARCH_VARIANTS,
  emptyConnectCatalog,
  mergeSearchMatches,
  parseSearchMatches,
  parseSkillIndex,
  type ConnectCatalog,
  type ConnectConnection,
  type ConnectPlugin,
  type ConnectSkill,
} from "@/lib/connect-catalog";
import {
  connectRowStatus,
  localToolStatus,
  parseEngineToolStatus,
  type EngineToolStatus,
  type PlainStatus,
} from "@/lib/connection-words";
import { buildDenAccountUrl, type DenSession } from "@/lib/den";
import {
  createCoworkerMcpClient,
  type CoworkerMcpAppCatalogServer,
  type CoworkerMcpAppResource,
  type CoworkerMcpClient,
  type CoworkerMcpItem,
  type CoworkerMcpServerTool,
  type PreservedMcpAppResult,
} from "@/lib/mcp";
import type { PanelCrumb } from "@/lib/panel-route";
import { AppsIcon, Button, IconButton, StatusDot, ToolIcon, inputClass } from "@/ui/kit";
import { McpAppFrame } from "@/ui/mcp-app-frame";
import { PanelLevel, type PanelDirection, type ReturnFocus } from "@/ui/panel-nav";
import { Fact, GroupLabel, QuietLine, Row, RowList, SkeletonRows, TechnicalDetails, useReturnFocus } from "@/ui/rows";

/** Remembered per machine once the person asks not to see the full explanation again. */
export const CONNECT_PITCH_KEY = "open-coworker.connect-pitch";

export function readConnectPitchPreference(storage: Pick<Storage, "getItem"> | null): "full" | "compact" {
  try {
    return storage?.getItem(CONNECT_PITCH_KEY) === "compact" ? "compact" : "full";
  } catch {
    return "full";
  }
}

/** What OpenWork Connect adds, said once, in the person's terms. */
const CONNECT_VALUE = [
  { title: "Bring your work with you", text: "Use the apps available through your OpenWork account. Some apps may need a separate sign-in." },
  { title: "Just describe the result", text: "Your coworker finds the right available app and handles the steps. No tool configuration to learn." },
  { title: "Keep your team's ways of working", text: "Use the skills and tools your team shares, with your existing access and approval controls." },
];

function appFailureMessage(result: PreservedMcpAppResult): string {
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string" || !item.text.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const message = Object.fromEntries(Object.entries(parsed)).message;
        if (typeof message === "string" && message.trim()) return message;
      }
    } catch {
      // Plain-text provider errors are already suitable for the compact UI.
    }
    return item.text;
  }
  return "This App could not start with the supplied input.";
}

function configured(item: CoworkerMcpItem): boolean {
  return item.config.enabled !== false && item.disabledByTools !== true;
}

function sourceLine(item: CoworkerMcpItem): string {
  return item.source === "config.project" ? "Set up for this coworker" : item.source === "config.global" ? "Set up on this Mac" : "Remote";
}

/** A small glyph per source, never invented per item. */
function SkillIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.25 9.6 6.4 13.75 8 9.6 9.6 8 13.75 6.4 9.6 2.25 8 6.4 6.4Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

function PluginIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6 2.75h4v2.5a1.25 1.25 0 1 0 2.5 0h.75v4.5h-2.5a1.25 1.25 0 1 0 0 2.5h2.5v1H6v-2.5a1.25 1.25 0 1 0-2.5 0h-.75V5.25h2.5A1.25 1.25 0 1 0 6 2.75Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

function ConnectionIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.75 9.25 9.25 6.75M5 11l-.9.9a2.3 2.3 0 0 1-3.25-3.25L3.4 6.1a2.3 2.3 0 0 1 3.25 0M11 5l.9-.9a2.3 2.3 0 0 1 3.25 3.25L12.6 9.9a2.3 2.3 0 0 1-3.25 0" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ConnectIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5.25 8.25 7.1 10 10.75 6.25" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className={spinning ? "motion-safe:animate-spin" : ""}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type LocalData = {
  inventory: CoworkerMcpItem[];
  servers: CoworkerMcpAppCatalogServer[];
  engine: Record<string, EngineToolStatus>;
  toolIds: string[];
};

const emptyLocal: LocalData = { inventory: [], servers: [], engine: {}, toolIds: [] };

/** The Connect catalog, read once per session and coworker; Refresh re-reads it. */
const connectCatalogCache = new Map<string, ConnectCatalog>();

function connectCacheKey(workspaceId: string, session: DenSession): string {
  return `${workspaceId}\u0000${session.baseUrl}\u0000${session.orgId}`;
}

async function readSkillIndex(runtime: RuntimeInfo): Promise<ConnectSkill[]> {
  const response = await fetch(`${runtime.serverUrl.replace(/\/+$/, "")}/experimental/connect/skills`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${runtime.ownerToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return [];
  return parseSkillIndex(await response.json());
}

async function searchGateway(client: CoworkerMcpClient, query: string) {
  const result = await client.callAppTool({
    serverName: CONNECT_MCP_NAME,
    name: "search_capabilities",
    resourceUri: "",
    arguments: { query, limit: 20 },
  });
  if (result.isError) throw new Error("Connected app search is temporarily unavailable.");
  return parseSearchMatches(result);
}

function useAppsToolsData(input: {
  client: CoworkerMcpClient | null;
  runtime: RuntimeInfo;
  session: DenSession | null;
  workspaceId: string;
  connected: boolean;
  connectStatus: string;
}) {
  const { client, runtime, session, workspaceId, connected, connectStatus } = input;
  const [local, setLocal] = useState<LocalData>(emptyLocal);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [connect, setConnect] = useState<ConnectCatalog>(emptyConnectCatalog);
  const [connectLoaded, setConnectLoaded] = useState(false);
  const [connectError, setConnectError] = useState("");
  const connectRequestRef = useRef(0);
  /** What each remote server on this Mac offers, once asked; null when it could not be read. */
  const [serverTools, setServerTools] = useState<Record<string, CoworkerMcpServerTool[] | null>>({});
  const askedServersRef = useRef(new Set<string>());
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState("");
  const serversRef = useRef(local.servers);
  serversRef.current = local.servers;

  const refreshLocal = useCallback(async () => {
    if (!client) return;
    setLoading((count) => count + 1);
    try {
      const [inventory, apps, engine, toolIds] = await Promise.all([
        client.listInventory(),
        client.listApps(),
        client.engineStatus().catch((): Record<string, unknown> => ({})),
        client.toolIds().catch((): string[] => []),
      ]);
      const parsedEngine: Record<string, EngineToolStatus> = {};
      for (const [name, value] of Object.entries(engine)) {
        const status = parseEngineToolStatus(value);
        if (status) parsedEngine[name] = status;
      }
      setLocal({ inventory: inventory.items, servers: apps.servers, engine: parsedEngine, toolIds });
      askedServersRef.current.clear();
      setServerTools({});
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLocalLoaded(true);
      setLoading((count) => count - 1);
    }
  }, [client]);

  const refreshConnect = useCallback(async (force: boolean) => {
    const requestId = ++connectRequestRef.current;
    setConnectError("");
    if (!client || !session || !connected) {
      setConnect(emptyConnectCatalog);
      setConnectLoaded(false);
      return;
    }
    const key = connectCacheKey(workspaceId, session);
    const cached = force ? undefined : connectCatalogCache.get(key);
    if (cached) {
      setConnect(cached);
      setConnectLoaded(true);
      return;
    }
    setLoading((count) => count + 1);
    try {
      let failures = 0;
      const [skills, ...searches] = await Promise.all([
        readSkillIndex(runtime).catch((): ConnectSkill[] => { failures += 1; return []; }),
        ...CONNECT_SEARCH_VARIANTS.map((query) => searchGateway(client, query).catch(() => { failures += 1; return []; })),
      ]);
      if (connectRequestRef.current !== requestId) return;
      if (failures > 0) setConnectError("Some connected apps and skills couldn't be loaded. Try again in a moment.");
      if (failures === CONNECT_SEARCH_VARIANTS.length + 1) return;
      const catalog = buildConnectCatalog({ skills, matches: mergeSearchMatches(searches), servers: serversRef.current });
      // Never remember a partial outage as the member's complete catalog.
      if (failures === 0) connectCatalogCache.set(key, catalog);
      setConnect(catalog);
    } finally {
      if (connectRequestRef.current === requestId) setConnectLoaded(true);
      setLoading((count) => count - 1);
    }
  }, [client, connected, runtime, session, workspaceId]);

  useEffect(() => {
    void refreshLocal();
  }, [refreshLocal, connectStatus]);
  useEffect(() => {
    if (!localLoaded) return;
    void refreshConnect(false);
    return () => { connectRequestRef.current += 1; };
  }, [localLoaded, refreshConnect]);

  const refresh = useCallback(async () => {
    await refreshLocal();
    await refreshConnect(true);
  }, [refreshConnect, refreshLocal]);

  useEffect(() => {
    if (!connected) return;
    let lastRefresh = Date.now();
    const refreshOnReturn = () => {
      if (Date.now() - lastRefresh < 15_000) return;
      lastRefresh = Date.now();
      void refresh();
    };
    window.addEventListener("focus", refreshOnReturn);
    window.addEventListener("online", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      window.removeEventListener("online", refreshOnReturn);
    };
  }, [connected, refresh]);

  /** Read what the named servers offer, once each; a server that cannot be read stays quiet. */
  const ensureServerTools = useCallback((names: readonly string[]) => {
    if (!client) return;
    for (const name of names) {
      if (askedServersRef.current.has(name)) continue;
      askedServersRef.current.add(name);
      void client.listServerTools(name)
        .then((tools) => setServerTools((current) => ({ ...current, [name]: tools })))
        .catch(() => setServerTools((current) => ({ ...current, [name]: null })));
    }
  }, [client]);

  return { local, localLoaded, connect, connectLoaded, connectError, serverTools, ensureServerTools, loading: loading > 0, error, refresh };
}

export type BesideControl = {
  /** Whether the window is wide enough to open a detail beside the conversation. */
  available: boolean;
  open: (path: PanelCrumb[]) => void;
};

export function CapabilitiesPanel({
  runtime,
  session,
  coworker,
  connect,
  onRepairConnect,
  onConnectAccount,
  onDiscuss,
  path,
  width,
  direction = "none",
  onPush,
  onSetPath,
  returnFocusRow = null,
  contentElement = null,
  beside,
  mode = "panel",
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  connect: ConnectState | null;
  onRepairConnect: () => void;
  onConnectAccount: () => void;
  /** Seed the discussion composer with a message the person still sends. */
  onDiscuss: (message: string) => void;
  /** The levels below Apps & tools this panel is showing. */
  path: PanelCrumb[];
  /** The panel's current width, for what fits on a row. */
  width: number;
  /** Which way the last move went, so the level slides in from the right side. */
  direction?: PanelDirection;
  onPush: (crumb: PanelCrumb, fromRow?: string) => void;
  onSetPath: (path: PanelCrumb[], fromRow?: string) => void;
  returnFocusRow?: ReturnFocus | null;
  contentElement?: HTMLElement | null;
  beside?: BesideControl;
  /** `beside`: hosting one detail next to the conversation; no lists, no search. */
  mode?: "panel" | "beside";
}) {
  const client = useMemo(
    () => coworker.workspaceId
      ? createCoworkerMcpClient({ serverUrl: runtime.serverUrl, workspaceId: coworker.workspaceId, token: runtime.ownerToken })
      : null,
    [coworker.workspaceId, runtime.ownerToken, runtime.serverUrl],
  );
  const signedIn = session !== null;
  const connected = signedIn && connect?.status === "connected";
  const data = useAppsToolsData({
    client,
    runtime,
    session,
    workspaceId: coworker.workspaceId,
    connected,
    connectStatus: connect?.status ?? "",
  });
  const apps = useMemo(() => catalogApps(data.local.servers), [data.local.servers]);
  const localInventory = useMemo(() => data.local.inventory.filter(isPersonalTool), [data.local.inventory]);
  const gatewayRegistered = data.local.inventory.some((item) => item.name === CONNECT_MCP_NAME);
  const rowStatus = connectRowStatus(connect, signedIn, session?.orgName ?? "");
  const screen = appsToolsScreen(path);
  const [query, setQuery] = useState("");
  const [searchEverywhere, setSearchEverywhere] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useReturnFocus(returnFocusRow, contentElement);

  // A new level starts with an empty field and its own scope.
  const screenKey = path.map((crumb) => crumb.id).join("/");
  useEffect(() => {
    setQuery("");
    setSearchEverywhere(false);
  }, [screenKey]);

  // ⌘F finds the search field of the level on screen while the panel is open.
  useEffect(() => {
    if (mode !== "panel") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "f" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.defaultPrevented) return;
      const field = searchRef.current;
      if (!field) return;
      event.preventDefault();
      field.focus();
      field.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode]);

  const localStatusFor = useCallback((item: CoworkerMcpItem) => {
    const server = data.local.servers.find((candidate) => candidate.serverName === item.name);
    return localToolStatus({
      enabled: configured(item),
      managedOAuth: item.managedOAuth,
      engine: data.local.engine[item.name] ?? null,
      ...(server ? { reachable: server.reachable } : {}),
    });
  }, [data.local.engine, data.local.servers]);

  // The lists and details that name what a server offers ask for it as they appear.
  const serversToRead = screen.kind === "local"
    ? localInventory.filter((item) => typeof item.config.url === "string").map((item) => item.name)
    : screen.kind === "tool" ? [screen.name] : [];
  const serversToReadKey = serversToRead.join("\u0000");
  const ensureServerTools = data.ensureServerTools;
  useEffect(() => {
    if (serversToReadKey) ensureServerTools(serversToReadKey.split("\u0000"));
  }, [ensureServerTools, serversToReadKey]);
  // A receipt named a tool before the catalog was read: swap the placeholder for the item's own trail.
  const pendingTool = screen.kind === "tool-ref" ? screen.tool : "";
  const localServerNames = localInventory.map((item) => item.name);
  const localServerKey = localServerNames.join("\u0000");
  useEffect(() => {
    if (!pendingTool || !data.localLoaded) return;
    const resolved = pathForTool(pendingTool, { apps, localServers: localServerKey ? localServerKey.split("\u0000") : [] });
    onSetPath(resolved ?? []);
  }, [apps, data.localLoaded, localServerKey, onSetPath, pendingTool]);

  /** Tool names for one server: what it says it offers, else what the AI service projects for it. */
  const toolNamesFor = useCallback((name: string): string[] => {
    const listed = data.serverTools[name];
    if (listed && listed.length > 0) return listed.map((tool) => tool.name);
    return toolIdsForServer(data.local.toolIds, name);
  }, [data.local.toolIds, data.serverTools]);

  const searchIndex = useMemo((): SearchableItem[] => [
    ...apps.map((app): SearchableItem => ({
      id: `app:${app.key}`,
      group: "apps",
      title: app.title,
      subtitle: app.sourceLabel,
      keywords: [app.description, app.catalog.toolName, app.serverLabel],
      path: appPath(app),
    })),
    ...data.connect.skills.map((skill): SearchableItem => ({
      id: `skill:${skill.capability}`,
      group: "skills",
      title: skill.title,
      subtitle: skill.builtIn ? "Built in" : skill.pluginName,
      keywords: [skill.description, skill.name, skill.marketplaceName],
      path: skillPath(skill),
    })),
    ...data.connect.plugins.map((plugin): SearchableItem => ({
      id: `plugin:${plugin.name}`,
      group: "plugins",
      title: plugin.name,
      subtitle: plugin.marketplaceName || "Your organization",
      keywords: plugin.skills.map((skill) => skill.title),
      path: pluginPath(plugin),
    })),
    ...data.connect.connections.map((connection): SearchableItem => ({
      id: `connection:${connection.id}`,
      group: "connections",
      title: connection.name,
      subtitle: connection.words.label,
      keywords: [connection.description],
      path: connectionPath(connection),
    })),
    ...localInventory.map((item): SearchableItem => ({
      id: `tool:${item.name}`,
      group: "local",
      title: item.name,
      subtitle: localStatusFor(item).label,
      keywords: [sourceLine(item), ...appsForServer(apps, item.name).map((app) => app.title), ...toolNamesFor(item.name).map(humanizeToolName)],
      path: toolPath(item.name),
    })),
  ], [apps, data.connect.connections, data.connect.plugins, data.connect.skills, localInventory, localStatusFor, toolNamesFor]);

  const scope: SearchGroup[] = searchEverywhere ? searchScope([]) : searchScope(path);
  const scopedEverywhere = scope.length === searchScope([]).length;
  const results = searchItems(searchIndex, query, scope);
  const askPrompt = (need: string) => `Help me with this using my connected apps: ${need}\n\nFind what's available and suggest the next step before taking action.`;

  const openRow = (target: PanelCrumb[], rowId: string) => onSetPath(target, rowId);

  const listScreen = screen.kind !== "app" && screen.kind !== "tool" && screen.kind !== "skill" && screen.kind !== "plugin" && screen.kind !== "connection" && screen.kind !== "tool-ref";
  const showSearch = mode === "panel" && listScreen && !(screen.kind === "connected" && !signedIn);

  const search = showSearch ? (
    <div className="mb-3 flex items-center gap-2">
      <input
        ref={searchRef}
        aria-label={scopedEverywhere ? "Search Apps and tools" : `Search in ${path[path.length - 1]?.title ?? "this level"}`}
        className={`${inputClass} h-9 bg-panel/60 text-xs`}
        placeholder={scopedEverywhere ? "Search Apps and tools" : `Search ${path[path.length - 1]?.title ?? ""}`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        data-testid="apps-tools-search"
      />
      {screen.kind === "root" ? (
        <IconButton label={data.loading ? "Refreshing" : "Refresh"} aria-busy={data.loading} disabled={data.loading} onClick={() => void data.refresh()}>
          <RefreshIcon spinning={data.loading} />
        </IconButton>
      ) : null}
    </div>
  ) : null;

  const screenBody = ((): ReactNode => {
    if (showSearch && query.trim()) {
      return (
        <div data-testid="coworker-capabilities" data-screen="search">
          {search}
          {results.length === 0 ? (
            <QuietLine testId="apps-tools-no-results">Nothing matches "{query.trim()}"{scopedEverywhere ? "" : " here"}.</QuietLine>
          ) : results.map((group) => (
            <section key={group.group} data-testid="apps-tools-search-group" data-group={group.group}>
              <GroupLabel count={group.items.length}>{group.title}</GroupLabel>
              <RowList label={group.title}>
                {group.items.map((item) => (
                  <Row
                    key={item.id}
                    id={item.id}
                    icon={groupIcon(item.group)}
                    title={item.title}
                    status={item.subtitle}
                    onOpen={() => openRow(item.path, item.id)}
                    testId="apps-tools-search-result"
                  />
                ))}
              </RowList>
            </section>
          ))}
          {!scopedEverywhere ? (
            <div className="pt-2">
              <Button variant="ghost" className="text-xs" onClick={() => setSearchEverywhere(true)} data-testid="apps-tools-search-everywhere">Search everywhere</Button>
            </div>
          ) : null}
          {results.length === 0 && connected ? (
            <Button variant="ghost" className="mt-2 w-full text-xs" data-testid="apps-tools-ask-search" onClick={() => onDiscuss(askPrompt(query.trim()))}>Ask {coworker.name} to find a way</Button>
          ) : null}
        </div>
      );
    }

    switch (screen.kind) {
      case "root":
        return (
          <div data-testid="coworker-capabilities" data-screen="root">
            {search}
            <RowList label="Apps and tools" testId="apps-tools-root">
              <Row
                id="connected"
                icon={<ConnectIcon />}
                title={APPS_TOOLS_CRUMBS.connected.title}
                status={rowStatus.label}
                tone={rowStatus.tone}
                count={connected && data.connectLoaded ? data.connect.skills.length + data.connect.connections.length + apps.filter((app) => app.source === "connect").length : null}
                onOpen={() => onPush(APPS_TOOLS_CRUMBS.connected, "connected")}
                testId="apps-tools-row-connected"
              />
              <Row
                id="apps"
                icon={<AppsIcon />}
                title={APPS_TOOLS_CRUMBS.apps.title}
                status={apps.length === 0 ? (data.localLoaded ? "No interactive apps available yet" : "Loading…") : appsSummary(apps)}
                count={apps.length}
                onOpen={() => onPush(APPS_TOOLS_CRUMBS.apps, "apps")}
                testId="apps-tools-row-apps"
              />
              <Row
                id="local"
                icon={<ToolIcon />}
                title={APPS_TOOLS_CRUMBS.local.title}
                status={localInventory.length === 0 ? (data.localLoaded ? "Nothing set up on this Mac yet" : "Reading") : localSummary(localInventory.map(localStatusFor))}
                count={localInventory.length}
                onOpen={() => onPush(APPS_TOOLS_CRUMBS.local, "local")}
                testId="apps-tools-row-local"
              />
            </RowList>
            {gatewayRegistered && !signedIn ? (
              <QuietLine>A previous OpenWork Connect setup is still registered; sign in again to use it.</QuietLine>
            ) : null}
            <ReadProblem error={data.error} />
          </div>
        );

      case "connected":
        return (
          <div data-testid="coworker-capabilities" data-screen="connected">
            <ConnectedScreen
              coworker={coworker}
              session={session}
              connect={connect}
              status={rowStatus}
              data={data}
              apps={apps}
              search={search}
              onConnectAccount={onConnectAccount}
              onRepairConnect={onRepairConnect}
              onDiscuss={onDiscuss}
              onOpen={(crumb, rowId) => onPush(crumb, rowId)}
            />
          </div>
        );

      case "connected-apps": {
        const connectApps = apps.filter((app) => app.source === "connect");
        return (
          <div data-testid="coworker-capabilities" data-screen="connected-apps">
            {search}
            {connectApps.length === 0 ? (
              data.localLoaded ? <QuietLine>Interactive apps available to you appear here. You can also ask your coworker to work with your connected services.</QuietLine> : <SkeletonRows />
            ) : (
              <RowList label="Apps from OpenWork Connect">
                {connectApps.map((app) => <AppRow key={app.key} app={app} onOpen={() => onPush({ id: `app:${app.key}`, title: app.title }, `app:${app.key}`)} />)}
              </RowList>
            )}
          </div>
        );
      }

      case "skills":
        return (
          <div data-testid="coworker-capabilities" data-screen="skills">
            {search}
            {!data.connectLoaded ? <SkeletonRows /> : data.connect.skills.length === 0 ? (
              <QuietLine>{data.connectError ? "Your skills couldn't be loaded yet." : "No skills are shared with you yet."}</QuietLine>
            ) : (
              <RowList label="Skills">
                {data.connect.skills.map((skill) => (
                  <Row
                    key={skill.capability}
                    id={`skill:${skill.capability}`}
                    icon={<SkillIcon />}
                    title={skill.title}
                    status={skill.builtIn ? "Built in" : [skill.pluginName, skill.marketplaceName].filter(Boolean).join(" · ")}
                    onOpen={() => onPush({ id: `skill:${skill.capability}`, title: skill.title }, `skill:${skill.capability}`)}
                    testId="apps-tools-skill"
                  />
                ))}
              </RowList>
            )}
          </div>
        );

      case "plugins":
        return (
          <div data-testid="coworker-capabilities" data-screen="plugins">
            {search}
            {!data.connectLoaded ? <SkeletonRows /> : data.connect.plugins.length === 0 ? (
              <QuietLine>{data.connectError ? "Your plugins couldn't be loaded yet." : "No plugins were found for your account."}</QuietLine>
            ) : (
              <RowList label="Plugins and marketplaces">
                {data.connect.plugins.map((plugin) => (
                  <Row
                    key={plugin.name}
                    id={`plugin:${plugin.name}`}
                    icon={<PluginIcon />}
                    title={plugin.name}
                    status={[plugin.marketplaceName || "Your organization", plugin.readiness.label].join(" · ")}
                    tone={plugin.readiness.tone}
                    count={plugin.skills.length}
                    onOpen={() => onPush({ id: `plugin:${plugin.name}`, title: plugin.name }, `plugin:${plugin.name}`)}
                    testId="apps-tools-plugin"
                  />
                ))}
              </RowList>
            )}
          </div>
        );

      case "connections":
        return (
          <div data-testid="coworker-capabilities" data-screen="connections">
            {search}
            {!data.connectLoaded ? <SkeletonRows /> : data.connect.connections.length === 0 ? (
              <QuietLine>{data.connectError ? "Your connected services couldn't be loaded yet." : "No connected services were found for your account."}</QuietLine>
            ) : (
              <RowList label="Connections">
                {data.connect.connections.map((connection) => (
                  <Row
                    key={connection.id}
                    id={`connection:${connection.id}`}
                    icon={<ConnectionIcon />}
                    title={connection.name}
                    status={connection.words.label}
                    tone={connection.words.tone}
                    count={connection.appCount > 0 ? connection.appCount : null}
                    onOpen={() => onPush({ id: `connection:${connection.id}`, title: connection.name }, `connection:${connection.id}`)}
                    testId="apps-tools-connection"
                  />
                ))}
              </RowList>
            )}
          </div>
        );

      case "apps":
        return (
          <div data-testid="coworker-capabilities" data-screen="apps">
            {search}
            {apps.length === 0 ? (
              data.localLoaded ? (
                <QuietLine>{signedIn ? "Nothing renders inline yet. Apps your organization connects and Apps from tools on this Mac appear here." : "Apps your organization connects appear here once you sign in."}</QuietLine>
              ) : <SkeletonRows />
            ) : (
              <RowList label="Apps">
                {apps.map((app) => <AppRow key={app.key} app={app} onOpen={() => onPush({ id: `app:${app.key}`, title: app.title }, `app:${app.key}`)} />)}
              </RowList>
            )}
          </div>
        );

      case "local":
        return (
          <div data-testid="coworker-capabilities" data-screen="local">
            {search}
            {localInventory.length === 0 ? (
              data.localLoaded ? <QuietLine testId="apps-tools-empty-local">Nothing set up on this Mac yet.</QuietLine> : <SkeletonRows />
            ) : (
              <RowList label="Tools on this Mac">
                {localInventory.map((item) => {
                  const status = localStatusFor(item);
                  const count = toolNamesFor(item.name).length;
                  return (
                    <Row
                      key={`${item.source}:${item.name}`}
                      id={`tool:${item.name}`}
                      icon={<ToolIcon />}
                      title={item.name}
                      status={status.label}
                      tone={status.tone}
                      count={count > 0 ? count : null}
                      onOpen={() => onPush({ id: `tool:${item.name}`, title: item.name }, `tool:${item.name}`)}
                      testId="coworker-mcp-connection"
                    />
                  );
                })}
              </RowList>
            )}
            <ReadProblem error={data.error} />
          </div>
        );

      case "app": {
        const app = apps.find((candidate) => candidate.key === screen.key);
        if (!app) {
          return <QuietLine testId="apps-tools-missing">{data.localLoaded ? "This App is no longer offered." : "Reading…"}</QuietLine>;
        }
        return (
          <div data-testid="coworker-capabilities" data-screen="app">
            {client ? (
              <AppDetail
                client={client}
                coworker={coworker}
                app={app}
                onDiscuss={onDiscuss}
                beside={mode === "panel" && beside?.available ? () => beside.open(path) : null}
              />
            ) : null}
          </div>
        );
      }

      case "tool": {
        const item = localInventory.find((candidate) => candidate.name === screen.name);
        if (!item) return <QuietLine testId="apps-tools-missing">{data.localLoaded ? "This tool is no longer set up." : "Reading…"}</QuietLine>;
        return (
          <div data-testid="coworker-capabilities" data-screen="tool">
            <ToolDetail
              item={item}
              status={localStatusFor(item)}
              tools={data.serverTools[item.name] ?? toolIdsForServer(data.local.toolIds, item.name).map((name): CoworkerMcpServerTool => ({ name, title: null, description: null, resourceUri: null }))}
              toolsRead={item.name in data.serverTools}
              apps={appsForServer(apps, item.name)}
              coworkerName={coworker.name}
              onDiscuss={onDiscuss}
              onOpenApp={(app) => onPush({ id: `app:${app.key}`, title: app.title }, `app:${app.key}`)}
            />
          </div>
        );
      }

      case "skill": {
        const skill = data.connect.skills.find((candidate) => candidate.capability === screen.capability);
        if (!skill) return <QuietLine testId="apps-tools-missing">{data.connectLoaded ? "This skill is no longer shared with you." : "Reading…"}</QuietLine>;
        return (
          <div data-testid="coworker-capabilities" data-screen="skill">
            <SkillDetail skill={skill} coworkerName={coworker.name} onDiscuss={onDiscuss} beside={mode === "panel" && beside?.available ? () => beside.open(path) : null} />
          </div>
        );
      }

      case "plugin": {
        const plugin = data.connect.plugins.find((candidate) => candidate.name === screen.name);
        if (!plugin) return <QuietLine testId="apps-tools-missing">{data.connectLoaded ? "This plugin is no longer available to you." : "Reading…"}</QuietLine>;
        return (
          <div data-testid="coworker-capabilities" data-screen="plugin">
            <PluginDetail plugin={plugin} onOpenSkill={(skill) => onPush({ id: `skill:${skill.capability}`, title: skill.title }, `skill:${skill.capability}`)} />
          </div>
        );
      }

      case "tool-ref":
        return (
          <div data-testid="coworker-capabilities" data-screen="tool-ref">
            <SkeletonRows count={2} />
          </div>
        );

      case "connection": {
        const connection = data.connect.connections.find((candidate) => candidate.id === screen.id);
        if (!connection) return <QuietLine testId="apps-tools-missing">{data.connectLoaded ? "This connection is no longer listed." : "Reading…"}</QuietLine>;
        return (
          <div data-testid="coworker-capabilities" data-screen="connection">
            <ConnectionDetail connection={connection} coworkerName={coworker.name} onAssign={() => onDiscuss(`Help me use ${connection.name} to: `)} />
          </div>
        );
      }
    }
  })();

  return (
    <PanelLevel key={screenKey} direction={direction}>
      {screenBody}
      {data.connectError && signedIn ? <div className="mt-3 px-1" role="status" data-testid="apps-tools-connect-problem">
        <p className="text-xs leading-relaxed text-mist">{data.connectError}</p>
        <Button variant="ghost" className="mt-1 text-xs" disabled={data.loading} onClick={() => void data.refresh()}>Try again</Button>
      </div> : null}
    </PanelLevel>
  );
}

function groupIcon(group: SearchGroup): ReactNode {
  switch (group) {
    case "apps": return <AppsIcon />;
    case "skills": return <SkillIcon />;
    case "plugins": return <PluginIcon />;
    case "connections": return <ConnectionIcon />;
    case "local": return <ToolIcon />;
  }
}

function appsSummary(apps: CatalogApp[]): string {
  const connect = apps.filter((app) => app.source === "connect").length;
  const local = apps.length - connect;
  if (connect > 0 && local > 0) return "From OpenWork Connect and this Mac";
  if (connect > 0) return "From OpenWork Connect";
  return "From tools on this Mac";
}

function localSummary(statuses: PlainStatus[]): string {
  const connected = statuses.filter((status) => status.label === "Connected").length;
  const attention = statuses.filter((status) => status.tone === "amber" || status.tone === "rose").length;
  if (attention > 0) return `${connected} connected · ${attention} ${attention === 1 ? "needs" : "need"} attention`;
  if (connected === statuses.length) return statuses.length === 1 ? "Connected" : "All connected";
  return `${connected} of ${statuses.length} connected`;
}

/** Reading failed somewhere: one quiet line, the raw message behind the fold. */
function ReadProblem({ error }: { error: string }) {
  if (!error) return null;
  return (
    <div className="mt-3 space-y-1" data-testid="apps-tools-read-problem">
      <QuietLine>Some of this could not be read just now. Refresh to try again.</QuietLine>
      <TechnicalDetails entries={[{ label: "Error", value: error }]} />
    </div>
  );
}

function AppRow({ app, onOpen }: { app: CatalogApp; onOpen: () => void }) {
  return (
    <Row
      id={`app:${app.key}`}
      icon={<AppsIcon />}
      title={app.title}
      status={app.reachable ? app.sourceLabel : `${app.sourceLabel} · Not connected`}
      tone={app.reachable ? undefined : "rose"}
      onOpen={onOpen}
      testId="coworker-mcp-app"
    />
  );
}

/**
 * The Connected with OpenWork screen: signed out, the explanation as the
 * first step (then the short card); signed in, what the coworker can do
 * first, then the four groups.
 */
function ConnectedScreen({
  coworker,
  session,
  connect,
  status,
  data,
  apps,
  search,
  onConnectAccount,
  onRepairConnect,
  onDiscuss,
  onOpen,
}: {
  coworker: CoworkerSummary;
  session: DenSession | null;
  connect: ConnectState | null;
  status: ReturnType<typeof connectRowStatus>;
  data: ReturnType<typeof useAppsToolsData>;
  apps: CatalogApp[];
  search: ReactNode;
  onConnectAccount: () => void;
  onRepairConnect: () => void;
  onDiscuss: (message: string) => void;
  onOpen: (crumb: PanelCrumb, rowId: string) => void;
}) {
  const signedIn = session !== null;
  const connected = signedIn && connect?.status === "connected";
  // The Connect explanation shows in full until it is skipped; "Don't show this again" makes the
  // compact form the remembered default on this machine.
  const [pitch, setPitch] = useState<"full" | "compact">(() => readConnectPitchPreference(typeof window === "undefined" ? null : window.localStorage));
  const [hidePitchNextTime, setHidePitchNextTime] = useState(false);
  const [openError, setOpenError] = useState("");
  const refreshAfterManageRef = useRef(false);
  useEffect(() => {
    const onReturn = () => {
      if (!refreshAfterManageRef.current) return;
      refreshAfterManageRef.current = false;
      void data.refresh();
    };
    window.addEventListener("focus", onReturn);
    return () => window.removeEventListener("focus", onReturn);
  }, [data.refresh]);
  async function manageApps() {
    if (!session) return;
    setOpenError("");
    try {
      refreshAfterManageRef.current = true;
      await coworkerBridge.openExternal(buildDenAccountUrl(session.baseUrl, "connections"));
    } catch {
      refreshAfterManageRef.current = false;
      setOpenError("Couldn't open your connected apps. Please try again.");
    }
  }
  function skipPitch(): void {
    setPitch("compact");
    if (hidePitchNextTime) {
      try {
        window.localStorage.setItem(CONNECT_PITCH_KEY, "compact");
      } catch {
        // Storage may be unavailable; the compact form still applies for this session.
      }
    }
  }

  if (!signedIn && pitch === "full") {
    // The first visit is a step, not a card: the whole screen explains Connect once, then
    // Continue, or Skip (optionally for good) into the short form.
    return (
      <div className="flex min-h-[420px] flex-col" data-testid="coworker-connect-card" data-status="signed-out" data-pitch="full">
        <div className="flex flex-1 flex-col justify-center px-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">OpenWork Connect</p>
          <h3 className="mt-2 text-lg font-semibold leading-snug tracking-[-0.01em] text-snow">Bring your organization's apps and tools to {coworker.name}.</h3>
          <ul className="mt-5 space-y-3">
            {CONNECT_VALUE.map((item) => (
              <li key={item.title} className="text-[13px] leading-relaxed text-mist">
                <span className="font-medium text-snow">{item.title}.</span> {item.text}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-6 space-y-2 px-1 pb-2">
          <Button variant="primary" className="h-9 w-full text-xs" onClick={onConnectAccount} data-testid="coworker-connect-cta">
            Continue with OpenWork
          </Button>
          <Button variant="ghost" className="h-9 w-full text-xs" onClick={skipPitch} data-testid="coworker-connect-skip">
            Skip
          </Button>
          <label className="flex cursor-pointer items-center justify-center gap-2 pt-1 text-[11px] text-mist">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--color-spark)]"
              checked={hidePitchNextTime}
              onChange={(event) => setHidePitchNextTime(event.target.checked)}
              data-testid="coworker-connect-hide-pitch"
            />
            Don't show this explanation again
          </label>
        </div>
      </div>
    );
  }

  if (!signedIn) {
    // The short form: one line and the one action; the explanation was read (or skipped) already.
    return (
      <section className="px-1 pt-1" data-testid="coworker-connect-card" data-status="signed-out" data-pitch="compact">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">OpenWork Connect</p>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-mist" data-testid="coworker-connect-status">
            <StatusDot tone={status.tone} />
            {status.label}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-mist">Bring your organization's apps and tools to {coworker.name}.</p>
        <Button variant="primary" className="mt-3 h-8 w-full text-xs" onClick={onConnectAccount} data-testid="coworker-connect-cta">
          Continue with OpenWork
        </Button>
      </section>
    );
  }

  const connectApps = apps.filter((app) => app.source === "connect");
  const toneClass = status.tone === "mint" ? "text-mint" : status.tone === "amber" ? "text-amber" : status.tone === "rose" ? "text-rose" : "text-mist";
  return (
    <>
      <section className="px-1 pb-3" data-testid="coworker-connect-card" data-status={connect?.status ?? "connecting"}>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">OpenWork Connect</p>
          <span className={`flex min-w-0 items-center gap-1.5 text-[11px] font-medium ${toneClass}`} data-testid="coworker-connect-status">
            <StatusDot tone={status.tone} />
            {status.label}
          </span>
        </div>
        <h3 className="mt-2 text-sm font-semibold leading-snug text-snow">
          {connected ? `Tell ${coworker.name} what you want to get done.` : !connect || connect.status === "connecting" ? "Getting your connected apps ready." : "Let's reconnect your apps."}
        </h3>
        {connected ? <p className="mt-2 text-xs leading-relaxed text-mist">Your coworker finds the right app from those available to you in {session.orgName || "your workspace"}. Just describe the result.</p> : null}
        {status.detail ? <p className="mt-2 text-xs leading-relaxed text-mist" data-testid="coworker-connect-detail">{status.detail}</p> : null}
        {connect?.status === "attention" || connect?.status === "unavailable" ? <TechnicalDetails entries={[{ label: "Connection details", value: connect.message }]} /> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" className="text-xs" disabled={!connected} onClick={() => onDiscuss("Help me use my connected apps to: ")} data-testid="coworker-connect-ask">
            Start with a task
          </Button>
          <Button
            variant="ghost"
            className="text-xs"
            disabled={!connected}
            data-testid="coworker-connect-create-skill"
            onClick={() => onDiscuss(
              "Help me turn a repeatable task into a skill for my team. The task is: ",
            )}
          >
            Create a skill
          </Button>
          {status.action === "repair" ? <Button variant="ghost" className="text-xs" onClick={onRepairConnect}>Try reconnecting</Button> : null}
          {status.action === "sign-in" ? <Button variant="ghost" className="text-xs" onClick={onConnectAccount}>Sign in again</Button> : null}
          <Button variant="ghost" className="text-xs" onClick={() => void manageApps()} data-testid="coworker-connect-manage">Manage apps</Button>
        </div>
        {openError ? <p role="alert" className="mt-2 text-xs text-rose">{openError}</p> : null}
      </section>
      {search}
      <RowList label="Connected with OpenWork" testId="apps-tools-connected">
        <Row
          id="connected-apps"
          icon={<AppsIcon />}
          title={APPS_TOOLS_CRUMBS.connectedApps.title}
          status={connectApps.length === 0 ? (data.localLoaded ? "No interactive apps available yet" : "Loading…") : "Open and use here"}
          count={connectApps.length}
          onOpen={() => onOpen(APPS_TOOLS_CRUMBS.connectedApps, "connected-apps")}
          testId="apps-tools-row-connected-apps"
        />
        <Row
          id="skills"
          icon={<SkillIcon />}
          title={APPS_TOOLS_CRUMBS.skills.title}
          status={!data.connectLoaded ? "Reading" : data.connect.skills.length === 0 ? "None shared with you yet" : "Built in and from your marketplaces"}
          count={data.connectLoaded ? data.connect.skills.length : null}
          onOpen={() => onOpen(APPS_TOOLS_CRUMBS.skills, "skills")}
          testId="apps-tools-row-skills"
        />
        <Row
          id="plugins"
          icon={<PluginIcon />}
          title={APPS_TOOLS_CRUMBS.plugins.title}
          status={!data.connectLoaded ? "Reading" : data.connect.plugins.length === 0 ? "None added yet" : pluginsSummary(data.connect.plugins)}
          count={data.connectLoaded ? data.connect.plugins.length : null}
          onOpen={() => onOpen(APPS_TOOLS_CRUMBS.plugins, "plugins")}
          testId="apps-tools-row-plugins"
        />
        <Row
          id="connections"
          icon={<ConnectionIcon />}
          title={APPS_TOOLS_CRUMBS.connections.title}
          status={!data.connectLoaded ? "Reading" : data.connect.connections.length === 0 ? "None yet" : connectionsSummary(data.connect.connections)}
          tone={data.connectLoaded && data.connect.connections.some((connection) => connection.words.tone !== "mint") ? "amber" : undefined}
          count={data.connectLoaded ? data.connect.connections.length : null}
          onOpen={() => onOpen(APPS_TOOLS_CRUMBS.connections, "connections")}
          testId="apps-tools-row-connections"
        />
      </RowList>
    </>
  );
}

function pluginsSummary(plugins: ConnectPlugin[]): string {
  const attention = plugins.filter((plugin) => plugin.readiness.tone !== "mint").length;
  const marketplaces = new Set(plugins.map((plugin) => plugin.marketplaceName).filter(Boolean)).size;
  const base = marketplaces > 0 ? `From ${marketplaces} ${marketplaces === 1 ? "marketplace" : "marketplaces"}` : "Added by your organization";
  return attention > 0 ? `${base} · ${attention} ${attention === 1 ? "needs" : "need"} attention` : base;
}

function connectionsSummary(connections: ConnectConnection[]): string {
  const ready = connections.filter((connection) => connection.words.tone === "mint").length;
  const attention = connections.length - ready;
  if (attention === 0) return connections.length === 1 ? "Connected" : "All connected";
  return `${ready} connected · ${attention} ${attention === 1 ? "needs" : "need"} attention`;
}

function DetailHeader({ icon, title, line, status }: { icon: ReactNode; title: string; line: string; status?: PlainStatus }) {
  return (
    <div className="flex items-start gap-3 px-1 pb-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-panel text-mist" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold leading-snug text-snow [overflow-wrap:anywhere]">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-mist">{line}</span>
      </span>
      {status ? (
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[11px] font-medium text-mist" data-testid="apps-tools-detail-status">
          <StatusDot tone={status.tone} />
          {status.label}
        </span>
      ) : null}
    </div>
  );
}

/** Two actions side by side when they fit, stacked when they do not. */
function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2 px-1 [&>*]:min-w-[7.5rem] [&>*]:flex-1">{children}</div>;
}

function AppDetail({
  client,
  coworker,
  app,
  onDiscuss,
  beside,
}: {
  client: CoworkerMcpClient;
  coworker: CoworkerSummary;
  app: CatalogApp;
  onDiscuss: (prompt: string) => void;
  /** Open this App in a column beside the conversation; null when the window is not wide enough. */
  beside: (() => void) | null;
}) {
  const { catalog, server } = app;
  const [inputText, setInputText] = useState(catalog.requiresInput ? "{\n  \n}" : "{}");
  const [advancedInput, setAdvancedInput] = useState(false);
  const [approvalArmed, setApprovalArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resource, setResource] = useState<CoworkerMcpAppResource | null>(null);
  const [result, setResult] = useState<PreservedMcpAppResult | null>(null);
  const [argumentsValue, setArgumentsValue] = useState<Record<string, unknown>>({});

  async function open(approved: boolean) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputText);
    } catch {
      setError("Arguments must be a JSON object.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("Arguments must be a JSON object.");
      return;
    }
    const args = Object.fromEntries(Object.entries(parsed));
    setBusy(true);
    setError("");
    setResource(null);
    setResult(null);
    try {
      const launch = {
        ...(catalog.connectionId ? { connectionId: catalog.connectionId } : {}),
        toolName: catalog.toolName,
        resourceUri: catalog.resourceUri,
        arguments: args,
      };
      const resolved = await client.resolveApp(catalog.projectedToolName, launch);
      if (!resolved.app) throw new Error("This App no longer offers a view.");
      const called = await client.callAppTool({
        serverName: resolved.app.serverName,
        name: resolved.app.toolName,
        resourceUri: resolved.app.resourceUri,
        arguments: args,
        ...(approved ? { approved: true } : {}),
      });
      if (called.isError) throw new Error(appFailureMessage(called));
      setArgumentsValue(args);
      setResource(resolved.app);
      setResult(called);
      setApprovalArmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const status: PlainStatus = server.reachable ? { label: "Ready", tone: "mint", detail: "" } : { label: "Not connected", tone: "rose", detail: "" };
  return (
    <div className="space-y-3" data-testid="coworker-mcp-app-detail">
      <DetailHeader icon={<AppsIcon />} title={app.title} line={app.sourceLabel} status={status} />
      {app.description ? <p className="px-1 text-xs leading-relaxed text-mist">{app.description}</p> : null}
      <div className="flex flex-wrap gap-1.5 px-1 text-[10px] text-mist">
        {catalog.requiresInput ? <span className="rounded-full border border-line px-2 py-0.5">Accepts input</span> : null}
        <span className="rounded-full border border-line px-2 py-0.5">{catalog.requiresApproval ? "Asks before it runs" : "Read only"}</span>
      </div>

      {!resource ? (
        <section className="space-y-3 px-1">
          {catalog.requiresInput ? <div className="space-y-2">
            <p className="text-xs leading-relaxed text-mist">Describe what you need. {coworker.name} can work out the details this app needs.</p>
            <Button variant="primary" className="w-full text-xs" disabled={!server.reachable} data-testid="apps-tools-ask" onClick={() => onDiscuss(`Help me use ${app.title} to: `)}>Ask {coworker.name} to use it</Button>
            <button type="button" className="text-[11px] text-mist underline underline-offset-4 hover:text-snow" aria-expanded={advancedInput} data-testid="apps-tools-advanced-input" onClick={() => { setAdvancedInput((value) => !value); setApprovalArmed(false); }}>Advanced input</button>
          </div> : null}
          {catalog.requiresInput && advancedInput ? (
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Input (JSON)</span>
              <textarea
                className={`${inputClass} min-h-24 resize-y bg-panel font-mono text-[11px]`}
                value={inputText}
                onChange={(event) => setInputText(event.target.value)}
                spellCheck={false}
              />
            </label>
          ) : null}
          {!catalog.requiresInput || advancedInput ? catalog.requiresApproval && approvalArmed ? (
            <div className="rounded-xl border border-amber/30 bg-amber/5 p-3">
              <p className="text-xs font-medium text-snow">Let {app.title} run once?</p>
              <p className="mt-1 text-[11px] leading-relaxed text-mist">OpenWork will run it one time with the input above.</p>
              <div className="mt-3 flex gap-2">
                <Button aria-busy={busy} variant="primary" className="flex-1 text-xs" disabled={busy} onClick={() => void open(true)}>
                  {busy ? "Opening…" : "Allow once"}
                </Button>
                <Button variant="ghost" className="text-xs" onClick={() => setApprovalArmed(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <ActionRow>
              <Button
                aria-busy={busy}
                variant="primary"
                className="text-xs"
                disabled={busy || !server.reachable}
                onClick={() => catalog.requiresApproval ? setApprovalArmed(true) : void open(false)}
                data-testid="apps-tools-open-app"
              >
                {busy ? "Opening…" : catalog.requiresApproval ? "Review and open" : "Open"}
              </Button>
              {beside ? (
                <Button variant="ghost" className="text-xs" disabled={!server.reachable} onClick={beside} data-testid="apps-tools-open-beside">
                  Open beside
                </Button>
              ) : null}
            </ActionRow>
          ) : null}
        </section>
      ) : null}

      {resource && result ? (
        <div className="px-1">
          <McpAppFrame
            client={client}
            app={resource}
            toolName={catalog.projectedToolName}
            input={argumentsValue}
            result={result}
            onClose={() => {
              setResource(null);
              setResult(null);
            }}
          />
          {beside ? (
            <div className="mt-2 flex justify-end">
              <Button variant="ghost" className="text-xs" onClick={beside} data-testid="apps-tools-open-beside">Open beside</Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <Problem message={error} /> : null}
      {!catalog.requiresInput || resource ? <div className="px-1">
        <Button
          variant="ghost"
          className="w-full text-xs"
          data-testid="apps-tools-ask"
          onClick={() => onDiscuss(`Help me use ${app.title} to: `)}
        >
          Ask {coworker.name}
        </Button>
      </div> : null}
      <div className="px-1">
        <TechnicalDetails entries={[
          { label: "Source", value: server.serverName },
          { label: "Tool", value: catalog.toolName },
          { label: "Resource", value: catalog.resourceUri },
          ...(catalog.connectionId ? [{ label: "Connection", value: catalog.connectionId }] : []),
        ]} />
      </div>
    </div>
  );
}

/** Something went wrong: the plain line stays short; the raw text lives behind the fold. */
function Problem({ message }: { message: string }) {
  return (
    <div className="px-1" data-testid="apps-tools-problem">
      <p className="text-xs leading-relaxed text-rose">This could not be opened.</p>
      <TechnicalDetails entries={[{ label: "Error", value: message }]} />
    </div>
  );
}

function ToolDetail({
  item,
  status,
  tools,
  toolsRead,
  apps,
  coworkerName,
  onDiscuss,
  onOpenApp,
}: {
  item: CoworkerMcpItem;
  status: ReturnType<typeof localToolStatus>;
  tools: CoworkerMcpServerTool[];
  /** Whether the server has answered (or refused) the question of what it offers. */
  toolsRead: boolean;
  apps: CatalogApp[];
  coworkerName: string;
  onDiscuss: (message: string) => void;
  onOpenApp: (app: CatalogApp) => void;
}) {
  const url = typeof item.config.url === "string" ? item.config.url : "";
  const command = Array.isArray(item.config.command) ? item.config.command.filter((part): part is string => typeof part === "string").join(" ") : typeof item.config.command === "string" ? item.config.command : "";
  return (
    <div className="space-y-3" data-testid="coworker-mcp-tool-detail">
      <DetailHeader icon={<ToolIcon />} title={item.name} line={sourceLine(item)} status={status} />
      {status.detail ? <p className="px-1 text-xs leading-relaxed text-mist" data-testid="apps-tools-status-help">{status.detail}</p> : null}
      <div className="px-1">
        <Button
          variant="primary"
          className="w-full text-xs"
          disabled={status.label === "Off"}
          data-testid="apps-tools-ask"
          onClick={() => onDiscuss(`Use the ${item.name} tool for this: `)}
        >
          Ask {coworkerName} to use it
        </Button>
      </div>
      {apps.length > 0 ? (
        <section>
          <GroupLabel count={apps.length}>Apps</GroupLabel>
          <RowList label={`Apps from ${item.name}`}>
            {apps.map((app) => <AppRow key={app.key} app={app} onOpen={() => onOpenApp(app)} />)}
          </RowList>
        </section>
      ) : null}
      <section className="px-1">
        <GroupLabel count={tools.length > 0 ? tools.length : undefined}>What it offers</GroupLabel>
        {tools.length === 0 ? (
          toolsRead || status.label !== "Connected" ? (
            <p className="text-xs leading-relaxed text-mist" data-testid="apps-tools-offers-empty">
              {status.label === "Connected" ? "It has not described what it offers." : "What it offers shows once it is connected."}
            </p>
          ) : <SkeletonRows count={2} />
        ) : (
          <ul className="divide-y divide-line/60" data-testid="apps-tools-offers">
            {tools.map((tool) => (
              <li key={tool.name} className="py-1.5" data-testid="apps-tools-offer">
                <span className="block text-xs text-snow">{tool.title?.trim() || humanizeToolName(tool.name)}</span>
                {tool.description ? <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-mist">{tool.description}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="px-1">
        <TechnicalDetails entries={[
          { label: "Identifier", value: item.name },
          { label: "Source", value: item.source },
          { label: "Address", value: url },
          { label: "Command", value: command },
          { label: "Tools", value: tools.map((tool) => tool.name).join(", ") },
          { label: "Error", value: status.technical },
        ]} />
      </div>
    </div>
  );
}

function SkillDetail({ skill, coworkerName, onDiscuss, beside }: { skill: ConnectSkill; coworkerName: string; onDiscuss: (message: string) => void; beside: (() => void) | null }) {
  return (
    <div className="space-y-3" data-testid="coworker-skill-detail">
      <DetailHeader icon={<SkillIcon />} title={skill.title} line={skill.builtIn ? "Built into OpenWork Connect" : [skill.pluginName, skill.marketplaceName].filter(Boolean).join(" · ")} />
      {skill.description ? <p className="px-1 text-xs leading-relaxed text-mist">{skill.description}</p> : null}
      <ActionRow>
        <Button
          variant="primary"
          className="text-xs"
          data-testid="apps-tools-ask"
          onClick={() => onDiscuss(`Use the "${skill.title}" skill to help me with: `)}
        >
          Ask {coworkerName} to use it
        </Button>
        {beside ? <Button variant="ghost" className="text-xs" onClick={beside} data-testid="apps-tools-open-beside">Open beside</Button> : null}
      </ActionRow>
      <div className="px-1">
        <TechnicalDetails entries={[
          { label: "Skill", value: skill.name },
          { label: "Capability", value: skill.capability },
        ]} />
      </div>
    </div>
  );
}

function PluginDetail({ plugin, onOpenSkill }: { plugin: ConnectPlugin; onOpenSkill: (skill: ConnectSkill) => void }) {
  return (
    <div className="space-y-3" data-testid="coworker-plugin-detail">
      <DetailHeader icon={<PluginIcon />} title={plugin.name} line={plugin.marketplaceName ? `In ${plugin.marketplaceName}` : "Added by your organization"} status={plugin.readiness} />
      {plugin.readiness.detail ? <p className="px-1 text-xs leading-relaxed text-mist">{plugin.readiness.detail}</p> : null}
      <section>
        <GroupLabel count={plugin.skills.length}>Skills</GroupLabel>
        {plugin.skills.length === 0 ? (
          <QuietLine>No skills in this plugin.</QuietLine>
        ) : (
          <RowList label={`Skills in ${plugin.name}`}>
            {plugin.skills.map((skill) => (
              <Row key={skill.capability} id={`skill:${skill.capability}`} icon={<SkillIcon />} title={skill.title} status={skill.description} onOpen={() => onOpenSkill(skill)} testId="apps-tools-skill" />
            ))}
          </RowList>
        )}
      </section>
      {plugin.servers.length > 0 ? (
        <section className="px-1">
          <GroupLabel count={plugin.servers.length}>Services it uses</GroupLabel>
          <ul className="divide-y divide-line/60" data-testid="apps-tools-plugin-servers">
            {plugin.servers.map((server) => (
              <li key={server.name} className="py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-xs font-medium text-snow">{server.title}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-mist"><StatusDot tone={server.readiness.tone} />{server.readiness.label}</span>
                </div>
                {server.connectionName ? <p className="mt-0.5 text-[11px] text-mist">Through {server.connectionName}</p> : null}
                {server.humanAction ? <p className="mt-0.5 text-[11px] leading-relaxed text-mist">{server.humanAction}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {plugin.otherKinds.length > 0 ? (
        <p className="px-1 text-[11px] text-mist">Also offers: {plugin.otherKinds.map((kind) => `${kind}s`).join(", ")}.</p>
      ) : null}
      <div className="px-1">
        <TechnicalDetails entries={[
          { label: "Plugin", value: plugin.name },
          { label: "Marketplace", value: plugin.marketplaceName },
          { label: "Servers", value: plugin.servers.map((server) => server.name).join(", ") },
        ]} />
      </div>
    </div>
  );
}

function ConnectionDetail({ connection, coworkerName, onAssign }: { connection: ConnectConnection; coworkerName: string; onAssign: () => void }) {
  return (
    <div className="space-y-3" data-testid="coworker-connection-detail">
      <DetailHeader icon={<ConnectionIcon />} title={connection.name} line={connection.appCount > 0 ? `${connection.appCount} ${connection.appCount === 1 ? "App" : "Apps"} render here` : "Organization connection"} status={connection.words} />
      {connection.description ? <p className="px-1 text-xs leading-relaxed text-mist">{connection.description}</p> : null}
      {connection.words.detail && connection.words.detail !== connection.description ? <p className="px-1 text-xs leading-relaxed text-mist">{connection.words.detail}</p> : null}
      {connection.words.humanAction ? (
        <div className="px-1">
          <Fact label="Next step" testId="apps-tools-human-action">{connection.words.humanAction}</Fact>
        </div>
      ) : null}
      <div className="px-1">
        <Button variant="primary" className="w-full text-xs" disabled={connection.words.tone !== "mint"} data-testid="apps-tools-ask" onClick={onAssign}>
          Ask {coworkerName} to use it
        </Button>
      </div>
      <div className="px-1">
        <TechnicalDetails entries={[{ label: "Connection", value: connection.id }]} />
      </div>
    </div>
  );
}
