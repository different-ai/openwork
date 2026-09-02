import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerSummary, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import { denApiBase, describeSkippedProvider, type DenSession } from "@/lib/den";
import {
  createCoworkerThreads,
  modelSourceLabel,
  type EngineModelCatalog,
  type EngineModelOption,
} from "@/lib/threads";
import { CoworkerMark, InlineLoader } from "@/ui/brand";
import { Button, ErrorNote, StatusDot } from "@/ui/kit";

export type SettingsSection = "general" | "account" | "models" | "engine";

const SECTIONS: Array<{ id: SettingsSection; label: string; detail: string }> = [
  { id: "general", label: "General", detail: "Open Coworker and shared defaults" },
  { id: "account", label: "Account", detail: "OpenWork account and organization" },
  { id: "models", label: "Models & providers", detail: "What every coworker can run" },
  { id: "engine", label: "Local engine", detail: "Runtime and local storage" },
];

const EMPTY_CATALOG: EngineModelCatalog = { models: [], connectedProviderIds: [], cloud: null };

function sectionTitle(section: SettingsSection): string {
  return SECTIONS.find((item) => item.id === section)?.label ?? "Settings";
}

function sectionDescription(section: SettingsSection): string {
  return SECTIONS.find((item) => item.id === section)?.detail ?? "OpenWork configuration";
}

function modelLabel(coworker: CoworkerSummary, models: EngineModelOption[], catalogLoaded: boolean): string {
  if (!coworker.model) return "OpenWork engine default";
  const match = models.find((model) => model.id === coworker.model);
  if (match) return `${match.label} · ${modelSourceLabel(match.source)}`;
  return catalogLoaded ? `${coworker.model} · unavailable` : coworker.model;
}

function modelHint(coworker: CoworkerSummary): string {
  if (!coworker.model) return "Follows the engine default";
  return coworker.modelVariant ? `${coworker.model} · reasoning ${coworker.modelVariant}` : coworker.model;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describeSyncRun(run: ProviderSyncRun | null, status: EngineModelCatalog["cloud"]): { value: string; hint: string; tone: "mint" | "amber" | "mist" } {
  const last = status?.lastRun ?? null;
  if (run?.status === "failed" || last?.status === "failed") {
    const message = run?.status === "failed" ? run.message : last?.message ?? "";
    return { value: "Last refresh failed", hint: message || "OpenWork did not answer.", tone: "amber" };
  }
  if (!last && !run) return { value: "Not refreshed yet", hint: "Providers refresh when you sign in.", tone: "mist" };
  const at = last?.at ? new Date(last.at).toLocaleString() : "";
  if (status?.reloadPending) {
    return { value: "Applied · engine reload pending", hint: "New providers appear once current work finishes.", tone: "amber" };
  }
  return { value: last?.status === "applied" || run?.status === "applied" ? "Up to date" : "Up to date · no changes", hint: at ? `Checked ${at}` : "", tone: "mint" };
}

function SettingsRow({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "mint" | "amber" | "rose" | "mist" }) {
  return (
    <div className="flex items-start gap-5 border-t border-line px-4 py-3.5 first:border-t-0">
      <span className="w-36 shrink-0 text-xs font-medium text-mist">{label}</span>
      <span className="min-w-0 flex-1 text-right">
        <span className="flex items-center justify-end gap-2">
          {tone ? <StatusDot tone={tone} /> : null}
          <span className="block truncate text-xs font-medium text-snow" title={value}>{value}</span>
        </span>
        {hint ? <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">{hint}</span> : null}
      </span>
    </div>
  );
}

function SettingsCard({ children, testId }: { children: ReactNode; testId?: string }) {
  return <section className="overflow-hidden rounded-2xl border border-line bg-panel/45" data-testid={testId}>{children}</section>;
}

export function OpenWorkSettings({
  active = true,
  runtime,
  session,
  providerSync,
  coworkers,
  selectedCoworker,
  initialSection = "general",
  onClose,
  onConnect,
  onSignOut,
  onSyncProviders,
  onRefreshRuntime,
}: {
  active?: boolean;
  runtime: RuntimeInfo;
  session: DenSession | null;
  /** Outcome of the most recent account provider sync this session, if any. */
  providerSync: ProviderSyncRun | null;
  coworkers: CoworkerSummary[];
  selectedCoworker: CoworkerSummary | null;
  initialSection?: SettingsSection;
  onClose: () => void;
  onConnect: () => void;
  /** Resolves once the embedded server has removed the account's providers. */
  onSignOut: () => Promise<void>;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onRefreshRuntime: () => Promise<void>;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [catalog, setCatalog] = useState<EngineModelCatalog>(EMPTY_CATALOG);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const catalogCoworker = selectedCoworker?.workspaceId
    ? selectedCoworker
    : (coworkers.find((coworker) => coworker.workspaceId) ?? null);
  const threads = useMemo(
    () =>
      catalogCoworker?.workspaceId
        ? createCoworkerThreads({
            serverUrl: runtime.serverUrl,
            workspaceId: catalogCoworker.workspaceId,
            token: runtime.ownerToken,
          })
        : null,
    [catalogCoworker?.workspaceId, runtime.ownerToken, runtime.serverUrl],
  );

  const refreshConfiguration = useCallback(async (options: { sync?: boolean } = {}) => {
    setRefreshing(true);
    setError("");
    try {
      if (options.sync && session) await onSyncProviders();
      await onRefreshRuntime();
      setCatalog(threads && runtime.engineManaged ? await threads.listModelCatalog() : EMPTY_CATALOG);
      setCatalogLoaded(Boolean(threads && runtime.engineManaged));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }, [onRefreshRuntime, onSyncProviders, runtime.engineManaged, session, threads]);

  useEffect(() => {
    if (!active) return;
    setSection(initialSection);
    headingRef.current?.focus({ preventScroll: true });
  }, [active, initialSection]);

  useEffect(() => {
    if (!active) return;
    void refreshConfiguration();
  }, [active, refreshConfiguration]);

  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    setError("");
    try {
      await onSignOut();
      await refreshConfiguration();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSigningOut(false);
    }
  }

  const models = catalog.models;
  const providers = Array.from(
    models.reduce((byProvider, model) => {
      const provider = byProvider.get(model.providerId) ?? { label: model.providerLabel, source: model.source, models: [] };
      provider.models.push(model);
      byProvider.set(model.providerId, provider);
      return byProvider;
    }, new Map<string, { label: string; source: EngineModelOption["source"]; models: EngineModelOption[] }>()),
  );
  // Account-backed providers stop being actionable the moment the account is
  // cleared, even if the engine is still completing its provider reload.
  const cloudProviders = session ? providers.filter(([, provider]) => provider.source === "cloud") : [];
  const localProviders = providers.filter(([, provider]) => provider.source === "local");
  const skipped = catalog.cloud?.skippedProviders ?? [];
  const sync = describeSyncRun(providerSync, catalog.cloud);
  const accountLabel = session ? session.userName || session.userEmail || "Signed in" : "Local mode";
  const accountHint = session
    ? [session.orgName, session.userEmail].filter(Boolean).join(" · ") || hostOf(session.baseUrl)
    : "No account is required for local coworkers.";

  return (
    <div className="flex h-full min-h-0 flex-1 bg-ink" data-testid="openwork-settings">
      <aside className="glass-rail flex h-full w-[252px] shrink-0 flex-col border-r border-line" data-testid="openwork-settings-sidebar">
        <div className="window-drag h-8 shrink-0" />
        <div className="window-no-drag px-3 pb-2">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-mist transition-colors hover:bg-white/5 hover:text-snow"
            onClick={onClose}
          >
            <span aria-hidden="true">←</span>
            <span>Back to coworkers</span>
          </button>
        </div>
        <div className="flex items-center gap-2.5 px-5 pb-5 pt-2">
          <CoworkerMark label="OpenWork settings" size={36} />
          <div>
            <p className="text-sm font-semibold tracking-[-0.02em] text-snow">OpenWork</p>
            <p className="text-[10px] text-mist">Global settings</p>
          </div>
        </div>
        <nav className="window-no-drag flex-1 px-3" aria-label="OpenWork settings">
          <p className="px-3 pb-1.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-mist/70">Settings</p>
          <div className="space-y-1">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={section === item.id ? "page" : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                  section === item.id ? "bg-white/8 text-snow" : "text-mist hover:bg-white/5 hover:text-snow"
                }`}
                onClick={() => setSection(item.id)}
              >
                <span className={`size-1.5 shrink-0 rounded-full ${section === item.id ? "bg-spark" : "bg-mist/45"}`} />
                <span className="truncate text-xs font-medium">{item.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="border-t border-line px-5 py-4 text-[10px] text-mist">
          <p className="font-medium text-snow/80">Open Coworker {runtime.version}</p>
          <p className="mt-0.5">Powered by OpenWork</p>
        </div>
      </aside>

      <section className="glass-main flex min-w-0 flex-1 flex-col">
        <header className="glass-header window-drag flex h-[62px] shrink-0 items-center justify-between border-b border-line px-7 pt-2">
          <div>
            <h1 ref={headingRef} tabIndex={-1} className="text-[15px] font-semibold text-snow outline-none">{sectionTitle(section)}</h1>
            <p className="mt-0.5 text-[11px] text-mist">{sectionDescription(section)}</p>
          </div>
          <Button variant="ghost" className="window-no-drag size-8 px-0" onClick={onClose} title="Close settings" aria-label="Close settings">×</Button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
          <div className="mx-auto w-full max-w-[760px] space-y-6">
            {section === "general" ? (
              <>
                <div>
                  <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">OpenWork settings</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-relaxed text-mist">
                    Account, runtime, and provider configuration apply across Open Coworker. Each teammate keeps its own identity, memory, and model preference.
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <button type="button" className="rounded-2xl border border-line bg-panel/45 p-4 text-left transition-colors hover:bg-white/[0.045]" onClick={() => setSection("account")}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-snow">Account</span>
                      <StatusDot tone={session ? "mint" : "mist"} />
                    </div>
                    <p className="mt-2 truncate text-xs text-mist">{session ? accountHint : "Local mode · connect when you want cloud work"}</p>
                  </button>
                  <button type="button" className="rounded-2xl border border-line bg-panel/45 p-4 text-left transition-colors hover:bg-white/[0.045]" onClick={() => setSection("engine")}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold text-snow">Local engine</span>
                      <StatusDot tone={runtime.engineManaged ? "mint" : "rose"} />
                    </div>
                    <p className="mt-2 text-xs text-mist">{runtime.engineManaged ? "Running · managed by Open Coworker" : "Unavailable · needs attention"}</p>
                  </button>
                </div>
                <SettingsCard>
                  <SettingsRow label="Coworkers" value={`${coworkers.length} teammate${coworkers.length === 1 ? "" : "s"}`} hint="Each teammate has an isolated OpenWork workspace." />
                  <SettingsRow
                    label="Models"
                    value={models.length > 0 ? `${models.length} available` : runtime.engineManaged ? (refreshing ? "Reading catalog" : "None connected") : "Unavailable"}
                    hint={models.length > 0 ? `${cloudProviders.length} OpenWork Cloud provider${cloudProviders.length === 1 ? "" : "s"} · ${localProviders.length} on this Mac` : "Provider connections are shared; model choices remain per coworker."}
                  />
                  <SettingsRow label="Storage" value={runtime.coworkersDir} hint="Identity and memory remain visible on this Mac." />
                </SettingsCard>
                {coworkers.length > 0 ? (
                  <SettingsCard>
                    {coworkers.map((coworker) => (
                      <SettingsRow
                        key={coworker.slug}
                        label={coworker.name}
                        value={modelLabel(coworker, models, catalogLoaded)}
                        hint={modelHint(coworker)}
                      />
                    ))}
                  </SettingsCard>
                ) : null}
              </>
            ) : null}

            {section === "account" ? (
              <>
                <div>
                  <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">OpenWork account</h2>
                  <p className="mt-1 text-sm leading-relaxed text-mist">
                    The same account as OpenWork Desktop. Signing in brings your organization's providers into this engine and lets responsibilities run in OpenWork Cloud.
                  </p>
                </div>
                <SettingsCard testId="account-card">
                  <div className="flex items-center gap-4 p-5">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-line bg-ink"><StatusDot tone={session ? "mint" : "mist"} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-snow" data-testid="account-status">{session ? "OpenWork connected" : "Local mode"}</span>
                      <span className="mt-1 block truncate text-xs text-mist">{session ? `${accountLabel} · ${accountHint}` : accountHint}</span>
                    </span>
                    {session ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button variant="ghost" onClick={onConnect} title="Sign in again to refresh this session">Reconnect</Button>
                        <Button variant="ghost" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</Button>
                      </div>
                    ) : (
                      <Button variant="primary" onClick={onConnect}>Continue with OpenWork</Button>
                    )}
                  </div>
                  {session ? (
                    <>
                      <SettingsRow label="Organization" value={session.orgName || session.orgId || "—"} hint={session.orgId && session.orgName ? session.orgId : undefined} />
                      <SettingsRow label="OpenWork" value={hostOf(session.baseUrl)} hint={`API · ${hostOf(denApiBase(session.baseUrl))}`} />
                      <SettingsRow label="Providers" value={sync.value} hint={sync.hint} tone={sync.tone} />
                      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4">
                        <button className="text-xs font-medium text-spark hover:underline" onClick={() => void coworkerBridge.openExternal(session.baseUrl)}>Open OpenWork in browser ↗</button>
                        <Button variant="ghost" disabled={refreshing} onClick={() => void refreshConfiguration({ sync: true })}>
                          {refreshing ? "Refreshing…" : "Refresh providers"}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="border-t border-line px-5 py-4 text-xs leading-relaxed text-mist">
                      Without an account, coworkers use providers configured on this Mac and responsibilities run only while Open Coworker is open.
                    </div>
                  )}
                </SettingsCard>
              </>
            ) : null}

            {section === "models" ? (
              <>
                <div className="flex items-start justify-between gap-5">
                  <div>
                    <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">Models & providers</h2>
                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-mist">
                      Read live from the OpenWork engine every coworker shares. OpenWork Cloud providers come from your signed-in account; the rest are configured on this Mac. Choose a model for an individual teammate from that coworker's settings.
                    </p>
                  </div>
                  <Button variant="ghost" disabled={refreshing} onClick={() => void refreshConfiguration({ sync: true })} data-testid="refresh-providers">
                    {refreshing ? "Refreshing…" : session ? "Refresh providers" : "Refresh"}
                  </Button>
                </div>
                {session ? (
                  <SettingsCard testId="provider-sync-status">
                    <SettingsRow label="OpenWork account" value={accountHint} tone="mint" />
                    <SettingsRow label="Provider sync" value={sync.value} hint={sync.hint} tone={sync.tone} />
                  </SettingsCard>
                ) : (
                  <SettingsCard>
                    <div className="flex items-center justify-between gap-4 p-4">
                      <p className="text-xs leading-relaxed text-mist">Sign in to use your organization's models alongside providers on this Mac.</p>
                      <Button variant="primary" className="shrink-0" onClick={onConnect}>Continue with OpenWork</Button>
                    </div>
                  </SettingsCard>
                )}
                {refreshing && models.length === 0 ? <div className="py-10"><InlineLoader label="Reading OpenWork models" /></div> : null}
                {!refreshing && providers.length === 0 ? (
                  <SettingsCard><p className="p-5 text-sm leading-relaxed text-mist">No connected provider models are available. Connect a provider in OpenWork, then refresh this catalog.</p></SettingsCard>
                ) : null}
                {[
                  { title: "OpenWork Cloud", entries: cloudProviders, testId: "cloud-providers" },
                  { title: "This Mac", entries: localProviders, testId: "local-providers" },
                ].map((group) => (
                  group.entries.length > 0 ? (
                    <div key={group.title} className="space-y-3" data-testid={group.testId}>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">{group.title}</p>
                      {group.entries.map(([providerId, provider]) => (
                        <SettingsCard key={providerId}>
                          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-snow">{provider.label}</span>
                              <span className="mt-0.5 block truncate text-[11px] text-mist">{providerId}</span>
                            </span>
                            <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[10px] font-medium text-mist">{provider.models.length} model{provider.models.length === 1 ? "" : "s"}</span>
                          </div>
                        </SettingsCard>
                      ))}
                    </div>
                  ) : null
                ))}
                {skipped.length > 0 ? (
                  <div className="space-y-3" data-testid="skipped-providers">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Granted, not usable here yet</p>
                    <SettingsCard>
                      {skipped.map((provider) => (
                        <SettingsRow key={provider.providerId} label={provider.name} value={provider.reason === "needs_key" ? "Needs your key" : "No credential"} hint={describeSkippedProvider(provider.reason)} tone="amber" />
                      ))}
                    </SettingsCard>
                  </div>
                ) : null}
              </>
            ) : null}

            {section === "engine" ? (
              <>
                <div className="flex items-start justify-between gap-5">
                  <div>
                    <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">Local engine</h2>
                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-mist">Open Coworker uses the same local OpenWork engine and workspace-scoped tools.</p>
                  </div>
                  <Button variant="ghost" disabled={refreshing} onClick={() => void refreshConfiguration()}>{refreshing ? "Checking…" : "Check again"}</Button>
                </div>
                <SettingsCard>
                  <SettingsRow label="Status" value={runtime.engineManaged ? "Running" : "Unavailable"} hint={runtime.engineManaged ? "Managed locally by Open Coworker" : runtime.engineError || "The local agent engine is offline."} tone={runtime.engineManaged ? "mint" : "rose"} />
                  <SettingsRow label="Application" value={`${runtime.appName} ${runtime.version}`} />
                  <SettingsRow label="Coworker home" value={runtime.coworkersDir} hint="Local identities, memory, and responsibility definitions." />
                  <SettingsRow label="Sign-in links" value={runtime.deepLinksRegistered ? `${runtime.deepLinkScheme}:// registered` : "Paste only"} hint={runtime.deepLinksRegistered ? "OpenWork can open this app directly after sign-in." : "Unpackaged and isolated launches accept the pasted sign-in link."} />
                </SettingsCard>
              </>
            ) : null}

            {error ? <ErrorNote>{error}</ErrorNote> : null}
          </div>
        </main>
      </section>
    </div>
  );
}
