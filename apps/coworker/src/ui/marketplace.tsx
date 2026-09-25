import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import type { AbilitySkill } from "@/lib/abilities";
import { describeConnect, type ConnectState } from "@/lib/connect";
import { buildDenLibraryUrl, listConnectionPresets, listUsableConnections, startConnection, type DenSession } from "@/lib/den";
import { FEATURED_COWORKERS, describeRoutine, featuredCoworker, featuredIdOf, type FeaturedCoworker } from "@/lib/featured-coworkers";
import {
  CONNECTORS,
  connector as connectorById,
  connectorState,
  coworkersUsing,
  matchesQuery,
  setupPath,
  type ConnectorCatalog,
  type ConnectorState,
  type MarketplaceConnector,
} from "@/lib/marketplace";
import { acknowledgeCoworker, CoworkerAvatar } from "@/ui/coworker-avatar";
import { ChevronIcon, IconButton, SearchIcon } from "@/ui/kit";
import { useFeatures } from "@/ui/use-features";

type View = { kind: "home" } | { kind: "setup" } | { kind: "connector"; id: string } | { kind: "coworker"; id: string };
type Tab = "coworkers" | "apps";

const SIGNED_OUT: ConnectorCatalog = { signedIn: false, connections: [], presets: [] };

// Quiet controls: one white primary per page, small outlined buttons everywhere else.
const PRIMARY = "inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-snow px-4 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-60";
const SECONDARY = "inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-white/15 px-3 text-[13px] text-snow transition-colors hover:bg-white/[0.06] disabled:opacity-60";
const LABEL = "text-[11px] font-semibold uppercase tracking-[0.14em] text-mist";

/** The member's connectors as OpenWork's Library lists them, re-read whenever the window comes back (after a browser sign-in). */
function useConnectorCatalog(session: DenSession | null, enabled: boolean) {
  const [catalog, setCatalog] = useState<ConnectorCatalog>(SIGNED_OUT);
  const [loading, setLoading] = useState(Boolean(session) && enabled);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!session || !enabled) {
      setCatalog(session ? { signedIn: true, connections: [], presets: [] } : SIGNED_OUT);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [connections, presets] = await Promise.all([listUsableConnections(session), listConnectionPresets(session)]);
      setCatalog({ signedIn: true, connections, presets });
      setError("");
    } catch (cause) {
      setCatalog({ signedIn: true, connections: [], presets: [] });
      setError(`Apps could not be read from OpenWork. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setLoading(false);
    }
  }, [enabled, session]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const again = () => void refresh();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refresh]);
  return { catalog, loading, error, refresh };
}

/**
 * The Marketplace: coworkers ready to join the team and, while Apps & tools is
 * on, the apps they use. It shows only what Settings › Features turns on: apps
 * and OpenWork Connect with Apps & tools, a coworker's routines with Calendar,
 * what it knows with Memory settings, its playbooks and skills with Abilities.
 * Apps are OpenWork's connectors, set up and signed in to there.
 */
export function MarketplaceDialog({ session, team, current, connect, onRepairConnect, onClose, onSignIn, onAdded, onOpenCoworker, onTry }: {
  session: DenSession | null;
  team: CoworkerSummary[];
  /** The coworker open behind the Marketplace, who can try an app right away. */
  current: CoworkerSummary | null;
  /** OpenWork Connect for the team: apps and organization skills reach coworkers only while it works. */
  connect: ConnectState | null;
  onRepairConnect: () => void;
  onClose: () => void;
  onSignIn: () => void;
  /** A featured coworker joined the team; the rail gains it and the Marketplace stays open. */
  onAdded: (coworker: CoworkerSummary) => void;
  onOpenCoworker: (slug: string) => void;
  /** Put an app's first message in the open coworker's composer. */
  onTry: (prompt: string) => void;
}) {
  const features = useFeatures();
  const appsOn = features.appsTools;
  const titleId = useId();
  const [view, setView] = useState<View>({ kind: "home" });
  const [tab, setTab] = useState<Tab>("coworkers");
  const [query, setQuery] = useState("");
  const { catalog, loading, error, refresh } = useConnectorCatalog(session, appsOn);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState("");
  const [addError, setAddError] = useState("");
  const [joined, setJoined] = useState<{ coworker: CoworkerSummary; note: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const onTeam = useMemo(() => new Map(team.map((member) => [featuredIdOf(member.templateOrigin), member] as const).filter(([id]) => id)), [team]);
  const connected = appsOn ? CONNECTORS.filter((entry) => connectorState(entry, catalog).state === "connected") : [];
  /** Apps connected in OpenWork reach coworkers through Connect; while it is down they wait. */
  const waiting = catalog.signedIn && connect?.status !== "connected";
  const manage = (pathname: string) => { if (session) void coworkerBridge.openExternal(buildDenLibraryUrl(session.baseUrl, pathname)); };
  const showingApps = appsOn && tab === "apps";

  const open = useCallback((next: View) => {
    setView(next);
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    // A view whose feature was turned off goes back home.
    if (!appsOn && (view.kind === "connector" || tab === "apps")) { setView({ kind: "home" }); setTab("coworkers"); }
  }, [appsOn, tab, view.kind]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (view.kind === "home") onClose();
        else open({ kind: "home" });
        return;
      }
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
      if (event.key === "/" && !typing && view.kind === "home") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, open, view.kind]);
  useEffect(() => {
    if (!joined) return;
    const timer = window.setTimeout(() => setJoined(null), joined.note ? 10_000 : 6_000);
    return () => window.clearTimeout(timer);
  }, [joined]);

  async function act(entry: MarketplaceConnector) {
    const status = connectorState(entry, catalog);
    if (status.state === "signin") { onSignIn(); return; }
    if (!session || status.state === "built-in" || status.state === "connected") return;
    setPending((current) => ({ ...current, [entry.id]: "" }));
    try {
      if (status.state === "setup") {
        await coworkerBridge.openExternal(buildDenLibraryUrl(session.baseUrl, setupPath(entry)));
        setPending((current) => ({ ...current, [entry.id]: `Finish setting up ${entry.name} in OpenWork, then come back.` }));
        return;
      }
      const started = await startConnection(session, status.connectionId);
      if (started.status === "needs_auth" && started.authorizeUrl) {
        await coworkerBridge.openExternal(started.authorizeUrl);
        setPending((current) => ({ ...current, [entry.id]: `Finish signing in to ${entry.name} in your browser, then come back.` }));
      } else {
        setPending((current) => { const next = { ...current }; delete next[entry.id]; return next; });
        await refresh();
      }
    } catch (cause) {
      setPending((current) => ({ ...current, [entry.id]: `${entry.name} could not be connected. ${cause instanceof Error ? cause.message : String(cause)}` }));
    }
  }

  async function add(featured: FeaturedCoworker) {
    setAdding(featured.id);
    setAddError("");
    try {
      const { coworker, skippedPlaybooks, notReady } = await coworkerBridge.marketplace.addCoworker(featured.id);
      onAdded(coworker);
      const notes = [
        skippedPlaybooks.length ? `Without ${skippedPlaybooks.join(" and ")}: your organization manages which skills can be added.` : "",
        notReady ? `${coworker.name} finishes getting ready when you open it.` : "",
      ];
      setJoined({ coworker, note: notes.filter(Boolean).join(" ") });
      acknowledgeCoworker(`marketplace:${featured.id}`, "wake");
    } catch (cause) {
      setAddError(`${featured.name} could not be added. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setAdding("");
    }
  }

  const addButton = (featured: FeaturedCoworker, primary = false) => {
    const member = onTeam.get(featured.id);
    const style = primary ? PRIMARY : SECONDARY;
    return member
      ? <button type="button" data-testid="marketplace-open-coworker" onClick={() => onOpenCoworker(member.slug)} className={`relative z-10 ${style}`}>Open</button>
      : <button type="button" data-testid="marketplace-add-coworker" onClick={() => void add(featured)} disabled={Boolean(adding)} aria-busy={adding === featured.id || undefined} className={`relative z-10 ${style}`}>{adding === featured.id ? "Adding…" : primary ? "Add to your team" : "Add"}</button>;
  };
  const connectNotice = appsOn && waiting ? <ConnectNotice connect={connect} onRepair={onRepairConnect} /> : null;

  const search = query.trim();
  let body: ReactNode;
  if (view.kind === "connector") {
    const entry = connectorById(view.id);
    body = entry ? (
      <ConnectorPage entry={entry} status={connectorState(entry, catalog)} message={pending[entry.id]} busy={pending[entry.id] === ""} loading={loading} team={team} current={current}
        notice={connectNotice} waiting={waiting}
        onManage={(connectionId) => manage(`/dashboard/library/connectors/${encodeURIComponent(connectionId)}`)}
        onAct={() => void act(entry)} onTry={() => onTry(entry.prompt)} onOpenCoworker={(id) => open({ kind: "coworker", id })} />
    ) : null;
  } else if (view.kind === "coworker") {
    const featured = featuredCoworker(view.id);
    body = featured ? (
      <CoworkerPage featured={featured} member={onTeam.get(featured.id)} action={addButton(featured, true)} error={addError}
        show={{ knows: features.memory, playbooks: features.abilities, routines: features.calendar, apps: appsOn }} waiting={waiting}
        app={(id) => {
          const entry = connectorById(id);
          return entry ? { entry, status: connectorState(entry, catalog), message: pending[entry.id], busy: pending[entry.id] === "" } : null;
        }}
        onAct={(entry) => void act(entry)} onOpenApp={(id) => open({ kind: "connector", id })} />
    ) : null;
  } else if (view.kind === "setup") {
    body = (
      <SetupView session={session} team={team} current={current} connect={connect} appsOn={appsOn} abilitiesOn={features.abilities}
        connected={connected} added={FEATURED_COWORKERS.flatMap((featured) => { const member = onTeam.get(featured.id); return member ? [member] : []; })}
        onRepair={onRepairConnect} onSignIn={onSignIn} onManage={() => manage("/dashboard/library")} onOpenMember={onOpenCoworker}
        onBrowseApps={() => { setTab("apps"); open({ kind: "home" }); }} onOpenApp={(id) => open({ kind: "connector", id })} />
    );
  } else {
    const coworkers = FEATURED_COWORKERS.filter((featured) => matchesQuery(search, featured.name, featured.role, featured.tagline));
    const apps = CONNECTORS.filter((entry) => matchesQuery(search, entry.name, entry.description, entry.category));
    body = (
      <div className="view-enter">
        {addError ? <p role="alert" className="mb-6 text-sm text-rose">{addError}</p> : null}
        {showingApps ? (
          <>
            {!catalog.signedIn ? (
              <div className="mb-6 flex flex-wrap items-center gap-3 border-b border-line pb-6" data-testid="marketplace-signin">
                <p className="min-w-0 flex-1 text-sm text-mist">Apps come with your OpenWork account.</p>
                <button type="button" onClick={onSignIn} className={SECONDARY}>Sign in</button>
              </div>
            ) : null}
            {connectNotice ? <div className="mb-6">{connectNotice}</div> : null}
            {error ? <p role="status" className="mb-4 text-xs text-amber">{error} <button type="button" className="underline" onClick={() => void refresh()}>Try again</button></p> : null}
            {apps.length ? (
              <div className="grid gap-x-10 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
                {apps.map((entry) => (
                  <AppRow key={entry.id} entry={entry} status={connectorState(entry, catalog)} message={pending[entry.id]} busy={pending[entry.id] === ""} waiting={waiting}
                    onAct={() => void act(entry)} onOpen={() => open({ kind: "connector", id: entry.id })} />
                ))}
              </div>
            ) : <p className="py-16 text-center text-sm text-mist">No app matches “{search}”.</p>}
          </>
        ) : coworkers.length ? (
          <div className="grid gap-x-8 gap-y-2 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
            {coworkers.map((featured) => (
              <CoworkerRow key={featured.id} featured={featured} action={addButton(featured)} onOpen={() => open({ kind: "coworker", id: featured.id })} />
            ))}
          </div>
        ) : <p className="py-16 text-center text-sm text-mist">No coworker matches “{search}”.</p>}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-5 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="marketplace" data-view={view.kind}
        className="window-no-drag relative flex h-[min(760px,calc(100vh-40px))] w-full max-w-[920px] flex-col overflow-hidden rounded-2xl border border-line bg-ink shadow-[0_32px_96px_rgb(0_0_0/0.6)]">
        <header className="flex shrink-0 items-center gap-2 px-7 pb-2 pt-6">
          {view.kind !== "home" ? <IconButton label="Back" tooltipSide="bottom" onClick={() => open({ kind: "home" })}><ChevronIcon direction="left" /></IconButton> : null}
          <h1 id={titleId} className="text-lg font-semibold tracking-[-0.015em] text-snow">Marketplace</h1>
          <div className="ml-auto flex items-center gap-1">
            {view.kind === "home" ? (
              <button type="button" data-testid="marketplace-setup" onClick={() => open({ kind: "setup" })} className="h-8 rounded-lg px-2.5 text-[13px] text-mist transition-colors hover:bg-white/[0.05] hover:text-snow">
                Your setup
              </button>
            ) : null}
            <IconButton label="Close Marketplace" tooltipSide="bottom" onClick={onClose} data-testid="marketplace-close">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="size-4" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
            </IconButton>
          </div>
        </header>
        {view.kind === "home" ? (
          <div className="flex shrink-0 items-center gap-6 px-7 pb-4 pt-2">
            {appsOn ? (
              <div role="tablist" aria-label="Show" className="flex gap-5">
                {(["coworkers", "apps"] as const).map((value) => (
                  <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} data-testid={`marketplace-tab-${value}`}
                    className={`-mb-px border-b py-1.5 text-sm capitalize transition-colors ${tab === value ? "border-snow text-snow" : "border-transparent text-mist hover:text-snow"}`}>
                    {value}
                  </button>
                ))}
              </div>
            ) : null}
            <label className={`relative w-full max-w-[260px] ${appsOn ? "ml-auto" : ""}`} data-testid="marketplace-search">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-mist" />
              <span className="sr-only">Search the Marketplace</span>
              <input ref={searchRef} autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search"
                className="h-8 w-full rounded-lg border border-line bg-transparent pl-8 pr-3 text-[13px] text-snow outline-none placeholder:text-mist/70 focus:border-spark/50" />
            </label>
          </div>
        ) : null}
        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-7 pb-10 pt-4">{body}</div>
        {joined ? (
          <div role="status" data-testid="marketplace-joined" className="mk-toast absolute bottom-6 left-1/2 flex max-w-[calc(100%-48px)] -translate-x-1/2 items-center gap-3 rounded-xl border border-line bg-panel py-2 pl-2 pr-2 shadow-[0_16px_48px_rgb(0_0_0/0.5)]">
            <CoworkerAvatar identity={`${joined.coworker.slug}:joined`} name={joined.coworker.name} color={joined.coworker.avatarColor} glasses={joined.coworker.avatarGlasses} size={30} animated={false} gaze={false} />
            <span className="min-w-0 text-sm text-snow">
              {joined.coworker.name} joined your team
              {joined.note ? <span className="block text-xs text-mist">{joined.note}</span> : null}
            </span>
            <button type="button" onClick={() => onOpenCoworker(joined.coworker.slug)} className={SECONDARY}>Say hi</button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** One featured coworker: its face (which follows the pointer), name and one line. */
function CoworkerRow({ featured, action, onOpen }: { featured: FeaturedCoworker; action: ReactNode; onOpen: () => void }) {
  const identity = `marketplace:${featured.id}`;
  return (
    <article data-testid="marketplace-coworker" data-id={featured.id} onPointerEnter={() => acknowledgeCoworker(identity)}
      className="group relative flex items-center gap-4 rounded-xl px-3 py-4 transition-colors hover:bg-white/[0.03]">
      <button type="button" onClick={onOpen} aria-label={`Meet ${featured.name}`} className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/60" />
      <span className="pointer-events-none relative"><CoworkerAvatar identity={identity} name={featured.name} color={featured.avatarColor} glasses={featured.avatarGlasses} size={48} motion="playful" /></span>
      <span className="pointer-events-none relative min-w-0 flex-1">
        <span className="block truncate text-[15px] text-snow">{featured.name}</span>
        <span className="mt-0.5 line-clamp-2 text-[13px] text-mist">{featured.tagline}</span>
      </span>
      {action}
    </article>
  );
}

const STATUS: Record<ConnectorState["state"], string> = {
  connected: "Connected",
  connect: "Ready to connect",
  setup: "Not set up",
  signin: "Needs an OpenWork account",
  "built-in": "Built in",
};

function AppRow({ entry, status, message, busy, waiting, onAct, onOpen }: {
  entry: MarketplaceConnector;
  status: ConnectorState;
  message?: string;
  busy: boolean;
  waiting: boolean;
  onAct: () => void;
  onOpen: () => void;
}) {
  // Only a connection is worth a status here; everything else reads as what the app does.
  const line = message || (status.state === "connected" ? (waiting ? "Connected · waiting for Connect" : "Connected") : entry.description);
  return (
    <div data-testid="marketplace-connector" data-id={entry.id} data-state={status.state} className="group relative flex items-center gap-3 border-b border-line py-3.5">
      <button type="button" onClick={onOpen} aria-label={`${entry.name}: details`} className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50" />
      <span className="pointer-events-none relative"><ConnectorLogo entry={entry} size={32} /></span>
      <span className="pointer-events-none relative min-w-0 flex-1">
        <span className="block truncate text-sm text-snow">{entry.name}</span>
        <span className={`block truncate text-xs ${status.state === "connected" && !waiting ? "text-mint" : "text-mist"}`} title={line}>{line}</span>
      </span>
      {status.state === "connect" ? <button type="button" onClick={onAct} disabled={busy} aria-busy={busy || undefined} className={`relative ${SECONDARY}`}>{busy ? "Connecting…" : "Connect"}</button> : null}
    </div>
  );
}

function ConnectorAction({ status, busy, loading, onClick }: { status: ConnectorState; busy: boolean; loading: boolean; onClick: () => void }) {
  switch (status.state) {
    case "built-in":
    case "connected":
      return <span className="text-sm text-mint">{STATUS[status.state]}</span>;
    case "signin":
      return <button type="button" onClick={onClick} className={PRIMARY}>Sign in to OpenWork</button>;
    case "connect":
      return <button type="button" onClick={onClick} disabled={busy} aria-busy={busy || undefined} className={PRIMARY}>{busy ? "Connecting…" : "Connect"}</button>;
    case "setup":
      return <button type="button" onClick={onClick} disabled={busy || loading} aria-busy={busy || undefined} className={PRIMARY}>Set up in OpenWork</button>;
  }
}

export function ConnectorLogo({ entry, size = 44 }: { entry: MarketplaceConnector; size?: number }) {
  return (
    <span className="flex items-center justify-center overflow-hidden bg-white" style={{ width: size, height: size, borderRadius: Math.max(5, Math.round(size * 0.22)) }} aria-hidden="true">
      {entry.icon ? <img src={`./connectors/${entry.icon}.svg`} alt="" className="size-[60%] object-contain" draggable={false} /> : (
        <svg viewBox="0 0 24 24" className="size-[56%] text-[#4a5568]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5Z" /></svg>
      )}
    </span>
  );
}

function ConnectorPage({ entry, status, message, busy, loading, team, current, notice, waiting, onManage, onAct, onTry, onOpenCoworker }: {
  entry: MarketplaceConnector;
  status: ConnectorState;
  message?: string;
  busy: boolean;
  loading: boolean;
  team: CoworkerSummary[];
  current: CoworkerSummary | null;
  notice: ReactNode;
  waiting: boolean;
  onManage: (connectionId: string) => void;
  onAct: () => void;
  onTry: () => void;
  onOpenCoworker: (id: string) => void;
}) {
  const { onTeam, suggested } = coworkersUsing(entry.id, team);
  const users = [...onTeam.map((member) => member.name), ...suggested.map((featured) => featured.name)];
  const line = message || {
    "built-in": "Built into every coworker.",
    connected: waiting ? `Connected in OpenWork. Coworkers can use it once OpenWork Connect is working again.` : "Connected. Every coworker can use it.",
    connect: "Set up in your organization. Connect your account and every coworker can use it.",
    setup: "Not set up yet. OpenWork walks you through it.",
    signin: "Apps come with your OpenWork account.",
  }[status.state];
  return (
    <article className="view-enter max-w-2xl" data-testid="marketplace-connector-detail" data-id={entry.id}>
      <div className="flex items-center gap-4">
        <ConnectorLogo entry={entry} size={56} />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-[-0.015em] text-snow">{entry.name}</h2>
          <p className="text-sm text-mist">{entry.description}</p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <ConnectorAction status={status} busy={busy} loading={loading} onClick={onAct} />
        {status.state === "connected" || status.state === "connect" ? (
          <button type="button" onClick={() => onManage(status.connectionId)} className="text-[13px] text-mist hover:text-snow">Manage in OpenWork</button>
        ) : null}
      </div>
      <p role="status" className="mt-3 text-[13px] text-mist">{line}</p>
      {notice ? <div className="mt-4">{notice}</div> : null}
      {users.length ? (
        <p className="mt-8 text-sm text-mist">
          Used by{" "}
          {onTeam.map((member, index) => <span key={member.slug} className="text-snow">{index ? ", " : ""}{member.name}</span>)}
          {suggested.map((featured, index) => (
            <span key={featured.id}>{onTeam.length || index ? ", " : ""}<button type="button" onClick={() => onOpenCoworker(featured.id)} className="text-snow underline decoration-white/25 underline-offset-2 hover:decoration-white/60">{featured.name}</button></span>
          ))}
          .
        </p>
      ) : null}
      {entry.prompt && current && (status.state === "connected" && !waiting) ? (
        <div className="mt-8 border-t border-line pt-6">
          <p className={LABEL}>Try asking</p>
          <p className="mt-2 text-sm leading-relaxed text-snow/90">“{entry.prompt}”</p>
          <button type="button" onClick={onTry} className={`mt-4 gap-2 pl-1.5 ${SECONDARY}`}>
            <CoworkerAvatar identity={`${current.slug}:try`} name={current.name} color={current.avatarColor} glasses={current.avatarGlasses} size={20} animated={false} gaze={false} />
            Ask {current.name}
          </button>
        </div>
      ) : null}
    </article>
  );
}

/** One line that opens to show more: the calm way to reveal a coworker's details. */
function Fold({ title, value, children, testId }: { title: string; value: string; children: ReactNode; testId: string }) {
  return (
    <details className="group/fold border-b border-line" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-4 py-3.5 [&::-webkit-details-marker]:hidden">
        <span className="w-40 shrink-0 text-sm text-snow">{title}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-mist">{value}</span>
        <ChevronIcon direction="right" className="size-3.5 shrink-0 text-mist transition-transform group-open/fold:rotate-90" />
      </summary>
      <div className="pb-5 pl-44 text-[13px] leading-relaxed text-snow/85">{children}</div>
    </details>
  );
}

function CoworkerPage({ featured, member, action, error, show, waiting, app, onAct, onOpenApp }: {
  featured: FeaturedCoworker;
  member?: CoworkerSummary;
  action: ReactNode;
  error: string;
  /** OpenWork Connect is not working, so connected apps are not reaching coworkers yet. */
  waiting: boolean;
  /** Which details the person's features show: memories, playbooks, routines, apps. */
  show: { knows: boolean; playbooks: boolean; routines: boolean; apps: boolean };
  app: (id: string) => { entry: MarketplaceConnector; status: ConnectorState; message?: string; busy: boolean } | null;
  onAct: (entry: MarketplaceConnector) => void;
  onOpenApp: (id: string) => void;
}) {
  const identity = `marketplace:${featured.id}`;
  const apps = featured.integrations.map((id) => app(id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return (
    <article className="view-enter max-w-2xl" data-testid="marketplace-coworker-detail" data-id={featured.id}>
      <div className="flex items-center gap-4">
        <CoworkerAvatar identity={identity} name={featured.name} color={featured.avatarColor} glasses={featured.avatarGlasses} size={64} motion="playful" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-[-0.015em] text-snow">{featured.name}</h2>
          <p className="text-sm text-mist">{featured.role}{member ? <span className="text-mint"> · on your team</span> : null}</p>
        </div>
        {action}
      </div>
      <p className="mt-5 text-[15px] leading-relaxed text-snow/85">{featured.description}</p>
      {error ? <p role="alert" className="mt-3 text-sm text-rose">{error}</p> : null}

      <div className="mt-8 space-y-3" aria-label="For example">
        <p className="ml-auto w-fit max-w-[80%] rounded-lg bg-spark/20 px-3.5 py-2 text-sm text-snow">{featured.sample.ask}</p>
        <div className="flex items-end gap-2">
          <CoworkerAvatar identity={`${identity}:sample`} name={featured.name} color={featured.avatarColor} glasses={featured.avatarGlasses} size={24} animated={false} gaze={false} />
          <p className="max-w-[80%] rounded-lg bg-white/[0.06] px-3.5 py-2 text-sm leading-relaxed text-snow">{featured.sample.reply}</p>
        </div>
      </div>

      <div className="mt-10 border-t border-line">
        <Fold title="How it works" value={`${featured.instructions.length} ground rules`} testId="marketplace-fold-instructions">
          <ul className="space-y-1.5">{featured.instructions.map((line) => <li key={line}>{line}</li>)}</ul>
        </Fold>
        {show.knows ? (
          <Fold title="What it knows" value={featured.memories.map((memory) => memory.title).join(", ")} testId="marketplace-fold-knows">
            <ul className="space-y-3">{featured.memories.map((memory) => <li key={memory.title}><span className="text-snow">{memory.title}.</span> <span className="text-mist">{memory.body}</span></li>)}</ul>
          </Fold>
        ) : null}
        {show.playbooks ? (
          <Fold title="Playbooks" value={featured.skills.map((skill) => skill.title).join(", ")} testId="marketplace-fold-playbooks">
            <ul className="space-y-3">{featured.skills.map((skill) => <li key={skill.name}><span className="text-snow">{skill.title}.</span> <span className="text-mist">{skill.description}</span></li>)}</ul>
          </Fold>
        ) : null}
        {show.routines ? (
          <Fold title="Routines" value={featured.routines.map((routine) => routine.name).join(", ")} testId="marketplace-fold-routines">
            <ul className="space-y-1.5">{featured.routines.map((routine) => <li key={routine.name}>{routine.name} <span className="text-mist">· {describeRoutine(routine)}</span></li>)}</ul>
          </Fold>
        ) : null}
        {show.apps && apps.length ? (
          <Fold title="Works with" value={apps.map((item) => item.entry.name).join(", ")} testId="marketplace-fold-apps">
            <ul className="space-y-2">
              {apps.map((item) => (
                <li key={item.entry.id} className="flex items-center gap-3">
                  <button type="button" onClick={() => onOpenApp(item.entry.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <ConnectorLogo entry={item.entry} size={24} />
                    <span className="truncate text-snow">{item.entry.name}</span>
                    {item.message || item.status.state !== "connect" ? (
                      <span className={`truncate text-xs ${item.status.state === "connected" && !item.message && !waiting ? "text-mint" : "text-mist"}`}>{item.message || STATUS[item.status.state]}</span>
                    ) : null}
                  </button>
                  {item.status.state === "connect" ? <button type="button" onClick={() => onAct(item.entry)} disabled={item.busy} className={SECONDARY}>Connect</button> : null}
                </li>
              ))}
            </ul>
          </Fold>
        ) : null}
      </div>
    </article>
  );
}

/** Playbooks the Marketplace installs, by skill name, so Your setup can name them as people saw them. */
const PLAYBOOKS = new Map(FEATURED_COWORKERS.flatMap((featured) => featured.skills.map((skill) => [skill.name, { title: skill.title, from: featured.name }] as const)));

/** Why apps and organization skills are not reaching coworkers right now, and the one thing to try. */
function ConnectNotice({ connect, onRepair }: { connect: ConnectState | null; onRepair: () => void }) {
  const described = describeConnect(connect, true);
  const repairable = connect?.status === "attention" || connect?.status === "unavailable";
  return (
    <div role="status" data-testid="marketplace-connect-notice" className="flex flex-wrap items-center gap-3 text-[13px]">
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${repairable ? "bg-amber" : "bg-mist"}`} />
      <span className="min-w-0 flex-1 text-mist">
        {repairable ? `OpenWork Connect ${described.label.toLowerCase()}, so coworkers can't reach your apps right now.` : "OpenWork Connect is starting. Your apps reach coworkers once it's ready."}
      </span>
      <button type="button" onClick={onRepair} className={SECONDARY}>Try reconnecting</button>
    </div>
  );
}

/**
 * Your setup: what this team has from the Marketplace and OpenWork, as a few
 * plain lists, limited to the features that are on. Coworkers added here
 * always; OpenWork Connect and connected apps with Apps & tools; the skills on
 * this Mac (removable when this team installed them) with Abilities.
 */
function SetupView({ session, team, current, connect, appsOn, abilitiesOn, connected, added, onRepair, onSignIn, onManage, onOpenMember, onBrowseApps, onOpenApp }: {
  session: DenSession | null;
  team: CoworkerSummary[];
  current: CoworkerSummary | null;
  connect: ConnectState | null;
  appsOn: boolean;
  abilitiesOn: boolean;
  connected: MarketplaceConnector[];
  added: CoworkerSummary[];
  onRepair: () => void;
  onSignIn: () => void;
  onManage: () => void;
  onOpenMember: (slug: string) => void;
  onBrowseApps: () => void;
  onOpenApp: (id: string) => void;
}) {
  const reader = current ?? team[0] ?? null;
  const [skills, setSkills] = useState<AbilitySkill[] | null>(null);
  const [skillsError, setSkillsError] = useState("");
  const [removing, setRemoving] = useState("");
  const load = useCallback(async () => {
    if (!abilitiesOn || !reader) { setSkills([]); return; }
    try {
      const catalog = await coworkerBridge.abilities.catalog({ slug: reader.slug, createdAt: reader.createdAt });
      setSkills(catalog.skills);
      setSkillsError(catalog.errors.length ? "Some skills could not be read." : "");
    } catch (cause) {
      setSkills([]);
      setSkillsError(`Skills could not be read. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [abilitiesOn, reader?.slug, reader?.createdAt]);
  useEffect(() => { void load(); }, [load]);
  const removable = (skill: AbilitySkill) => Boolean(skill.location && /[\\/]\.runtime[\\/]\.opencode[\\/]skills[\\/]/.test(skill.location));
  async function remove(skill: AbilitySkill) {
    setRemoving(skill.name);
    try {
      await coworkerBridge.marketplace.removeSkill(skill.name);
      await load();
    } catch (cause) {
      setSkillsError(`${skill.name} could not be removed. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setRemoving("");
    }
  }
  const connectLine = !session ? "Not signed in" : !connect || connect.status === "connecting" ? "Starting" : describeConnect(connect, true).label;
  const connectDot = !session || !connect || connect.status === "connecting" ? "bg-mist/60" : connect.status === "connected" ? "bg-mint" : "bg-amber";
  return (
    <div className="view-enter max-w-2xl space-y-10" data-testid="marketplace-setup-view">
      <h2 className="text-xl font-semibold tracking-[-0.015em] text-snow">Your setup</h2>

      <section aria-label="Added from the Marketplace">
        <p className={LABEL}>Added from the Marketplace</p>
        {added.length ? (
          <ul className="mt-2 border-t border-line">
            {added.map((member) => (
              <li key={member.slug} className="flex items-center gap-3 border-b border-line py-3">
                <CoworkerAvatar identity={`${member.slug}:setup`} name={member.name} color={member.avatarColor} glasses={member.avatarGlasses} size={30} animated={false} gaze={false} />
                <span className="min-w-0 flex-1 truncate text-sm text-snow">{member.name}<span className="ml-2 text-xs text-mist">{member.role}</span></span>
                <button type="button" onClick={() => onOpenMember(member.slug)} className={SECONDARY}>Open</button>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-[13px] text-mist">No one yet.</p>}
      </section>

      {appsOn ? (
        <section aria-label="Apps" data-testid="marketplace-connect-card">
          <div className="flex items-center justify-between gap-3">
            <p className={LABEL}>Apps</p>
            <button type="button" onClick={onBrowseApps} className="text-[13px] text-mist hover:text-snow">Browse apps</button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 border-y border-line py-3">
            <span aria-hidden="true" className={`size-1.5 rounded-full ${connectDot}`} />
            <span className="min-w-0 flex-1 text-sm text-snow">OpenWork Connect<span className="ml-2 text-xs text-mist">{connectLine}{session?.orgName ? ` · ${session.orgName}` : ""}</span></span>
            {!session ? <button type="button" onClick={onSignIn} className={SECONDARY}>Sign in</button> : (
              <>
                {connect?.status !== "connected" ? <button type="button" onClick={onRepair} className={SECONDARY}>Try reconnecting</button> : null}
                <button type="button" onClick={onManage} className="text-[13px] text-mist hover:text-snow">Manage</button>
              </>
            )}
          </div>
          {connected.length ? (
            <ul>
              {connected.map((entry) => (
                <li key={entry.id} className="border-b border-line">
                  <button type="button" onClick={() => onOpenApp(entry.id)} className="flex w-full items-center gap-3 py-3 text-left">
                    <ConnectorLogo entry={entry} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm text-snow">{entry.name}</span>
                    <span className="text-xs text-mint">Connected</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="py-3 text-[13px] text-mist">No apps connected yet.</p>}
        </section>
      ) : null}

      {abilitiesOn ? (
        <section aria-label="Skills">
          <p className={LABEL}>Skills</p>
          {skillsError ? <p role="status" className="mt-2 text-xs text-amber">{skillsError}</p> : null}
          <ul className="mt-2 border-t border-line">
            {skills === null ? <li className="py-3 text-[13px] text-mist">Reading skills…</li> : skills.length ? skills.map((skill) => {
              const playbook = PLAYBOOKS.get(skill.name);
              return (
              <li key={skill.id} className="flex items-center gap-3 border-b border-line py-3" data-testid="marketplace-local-skill" data-name={skill.name}>
                <span className="min-w-0 flex-1 truncate text-sm text-snow">
                  {playbook?.title ?? skill.name}
                  <span className="ml-2 text-xs text-mist">{skill.source === "cloud" ? `From ${session?.orgName || "your organization"}` : playbook ? `${playbook.from}'s playbook` : "On this Mac"}</span>
                </span>
                {removable(skill) ? <button type="button" disabled={Boolean(removing)} onClick={() => void remove(skill)} className="text-[13px] text-mist hover:text-rose disabled:opacity-60">{removing === skill.name ? "Removing…" : "Remove"}</button> : null}
              </li>
              );
            }) : <li className="py-3 text-[13px] text-mist">No skills yet.</li>}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
