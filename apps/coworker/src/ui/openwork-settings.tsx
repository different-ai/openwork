import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  coworkerBridge,
  type CoworkerSettings,
  type CoworkerSummary,
  type LocalRunStatus,
  type ProviderSyncRun,
  type RuntimeInfo,
} from "@/lib/bridge";
import { denApiBase, describeSkippedProvider, type DenSession } from "@/lib/den";
import {
  createCoworkerThreads,
  modelSourceLabel,
  type EngineModelCatalog,
  type EngineModelOption,
} from "@/lib/threads";
import { clearAutoPicked } from "@/lib/model-choice";
import { CoworkerMark, InlineLoader } from "@/ui/brand";
import { Button, ErrorNote, StatusDot } from "@/ui/kit";
import { LocalProviders } from "@/ui/local-providers";

export type SettingsSection = "general" | "account" | "models" | "engine";

const SECTIONS: Array<{ id: SettingsSection; label: string; detail: string }> = [
  { id: "general", label: "General", detail: "Open Coworker and shared defaults" },
  { id: "account", label: "Account", detail: "OpenWork account and organization" },
  { id: "models", label: "AI models", detail: "What every coworker can use: your account, this Mac, and the free model" },
  { id: "engine", label: "AI & local setup", detail: "AI service, responsibilities on this Mac, and storage" },
];

const EMPTY_CATALOG: EngineModelCatalog = { models: [], connectedProviderIds: [], cloud: null };

function sectionTitle(section: SettingsSection): string {
  return SECTIONS.find((item) => item.id === section)?.label ?? "Settings";
}

function sectionDescription(section: SettingsSection): string {
  return SECTIONS.find((item) => item.id === section)?.detail ?? "OpenWork configuration";
}

function modelLabel(coworker: CoworkerSummary, models: EngineModelOption[], catalogLoaded: boolean): string {
  if (!coworker.model) return "Default AI model";
  const match = models.find((model) => model.id === coworker.model);
  if (match) return `${match.label} · ${modelSourceLabel(match.source)}`;
  return catalogLoaded ? `${coworker.model} · unavailable` : coworker.model;
}

function modelHint(coworker: CoworkerSummary): string {
  if (!coworker.model) return "Follows OpenWork's default AI model";
  return coworker.modelVariant ? `${coworker.model} · thinking effort ${coworker.modelVariant}` : coworker.model;
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
    return { value: "Applied · finishing current work", hint: "New providers appear once current work finishes.", tone: "amber" };
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
  onRestartRuntime,
  onCoworkerChanged,
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
  /** Stop and start the local AI service. */
  onRestartRuntime: () => Promise<void>;
  /** A coworker's AI model was chosen here. */
  onCoworkerChanged?: (coworker: CoworkerSummary) => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  async function chooseModelFor(coworker: CoworkerSummary, modelId: string) {
    setError("");
    try {
      clearAutoPicked(coworker.slug);
      onCoworkerChanged?.(await coworkerBridge.coworkers.update(coworker.slug, { model: modelId, modelVariant: "", modelChosenBy: "person" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const [restarting, setRestarting] = useState(false);
  async function restartRuntime() {
    setRestarting(true);
    setError("");
    try {
      await onRestartRuntime();
      await refreshConfiguration();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestarting(false);
    }
  }
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
  // cleared, even if the AI service is still completing its provider reload.
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
                    Your account, AI providers, and local setup apply across Open Coworker. Each coworker keeps its own identity, memory, and AI model in its own settings.
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
                      <span className="text-sm font-semibold text-snow">AI & local setup</span>
                      <StatusDot tone={runtime.engineManaged ? "mint" : "rose"} />
                    </div>
                    <p className="mt-2 text-xs text-mist">{runtime.engineManaged ? "AI is ready" : "AI needs attention"}</p>
                  </button>
                </div>
                <SettingsCard>
                  <SettingsRow label="Coworkers" value={`${coworkers.length} coworker${coworkers.length === 1 ? "" : "s"}`} hint="Each coworker has its own OpenWork workspace." />
                  <SettingsRow
                    label="AI models"
                    value={models.length > 0 ? `${models.length} available` : runtime.engineManaged ? (refreshing ? "Reading models" : "None connected") : "Unavailable"}
                    hint={models.length > 0 ? `${cloudProviders.length} OpenWork Cloud provider${cloudProviders.length === 1 ? "" : "s"} · ${localProviders.length} on this Mac` : "Provider connections are shared; each coworker chooses its own AI model."}
                  />
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
                    The same account as OpenWork Desktop. Signing in brings your organization's AI providers to every coworker and lets responsibilities run in OpenWork Cloud.
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
                    <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">AI models</h2>
                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-mist">
                      Everything connected here is available to every coworker; each one picks its own AI model in Coworker settings.
                    </p>
                  </div>
                  {session ? (
                    <Button variant="ghost" disabled={refreshing} onClick={() => void refreshConfiguration({ sync: true })} data-testid="refresh-providers">
                      {refreshing ? "Refreshing…" : "Refresh providers"}
                    </Button>
                  ) : null}
                </div>
                {session ? (
                  <div className="space-y-3" data-testid="cloud-providers">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">OpenWork Cloud</p>
                    <SettingsCard testId="provider-sync-status">
                      <SettingsRow label="OpenWork account" value={accountHint} tone="mint" />
                      <SettingsRow label="Provider refresh" value={sync.value} hint={sync.hint} tone={sync.tone} />
                      {cloudProviders.map(([providerId, provider]) => (
                        <SettingsRow key={providerId} label={provider.label} value={`${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`} hint={providerId} />
                      ))}
                      {refreshing && cloudProviders.length === 0 ? <div className="px-4 py-3"><InlineLoader label="Reading AI models" /></div> : null}
                    </SettingsCard>
                    {skipped.length > 0 ? (
                      <SettingsCard testId="skipped-providers">
                        {skipped.map((provider) => (
                          <SettingsRow key={provider.providerId} label={provider.name} value={provider.reason === "needs_key" ? "Needs your key" : "No credential"} hint={describeSkippedProvider(provider.reason)} tone="amber" />
                        ))}
                      </SettingsCard>
                    ) : null}
                  </div>
                ) : null}
                <div data-testid="this-mac-providers">
                  {session ? <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">This Mac</p> : null}
                  <LocalProviders
                    key={String(active)}
                    runtime={runtime}
                    session={session}
                    onConnectAccount={onConnect}
                    onModelsChanged={() => void refreshConfiguration()}
                    onRuntimeChanged={onRefreshRuntime}
                    onStartModel={selectedCoworker ? (modelId) => void chooseModelFor(selectedCoworker, modelId) : undefined}
                    chooseLabel={selectedCoworker ? `Use for ${selectedCoworker.name}` : undefined}
                  />
                </div>
              </>
            ) : null}

            {section === "engine" ? (
              <>
                <div className="flex items-start justify-between gap-5">
                  <div>
                    <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">AI & local setup</h2>
                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-mist">The local AI service that runs every coworker on this Mac, plus where their files live.</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!runtime.engineManaged ? (
                      <Button variant="ghost" disabled={restarting} onClick={() => void restartRuntime()}>{restarting ? "Restarting…" : "Restart AI"}</Button>
                    ) : null}
                    <Button variant="ghost" disabled={refreshing} onClick={() => void refreshConfiguration()}>{refreshing ? "Checking…" : "Check again"}</Button>
                  </div>
                </div>
                <SettingsCard testId="local-setup-card">
                  <SettingsRow label="AI service" value={runtime.engineManaged ? "AI is ready" : "AI is unavailable"} hint={runtime.engineManaged ? "Runs with Open Coworker on this Mac." : "Coworkers cannot work until it is running again."} tone={runtime.engineManaged ? "mint" : "rose"} />
                  <SettingsRow label="Application" value={`${runtime.appName} ${runtime.version}`} />
                  <SettingsRow label="Coworker files" value={runtime.coworkersDir} hint="Identities, memory, and responsibility definitions stay on this Mac." />
                  <SettingsRow label="Sign-in links" value={runtime.deepLinksRegistered ? `${runtime.deepLinkScheme}:// registered` : "Paste only"} hint={runtime.deepLinksRegistered ? "OpenWork can open this app directly after sign-in." : "Unpackaged and isolated launches accept the pasted sign-in link."} />
                </SettingsCard>
                <LocalRunsCard active={active} />
                {runtime.engineError ? (
                  <details className="rounded-2xl border border-line bg-panel/45 px-4 py-3 text-xs text-mist" data-testid="local-setup-technical">
                    <summary className="cursor-pointer select-none font-medium text-snow/85">Technical details</summary>
                    <p className="mt-2 break-words font-mono text-[11px] leading-relaxed">{runtime.engineError}</p>
                  </details>
                ) : null}
              </>
            ) : null}

            {error ? <ErrorNote>{error}</ErrorNote> : null}
          </div>
        </main>
      </section>
    </div>
  );
}

const PARALLEL_CHOICES = [1, 2, 3, 4, 6, 8];
const GAP_CHOICES = [15, 30, 60];
const PER_DAY_CHOICES = [1, 2, 4, 6, 8, 12];

/** One row of small radio choices, as the limit control is drawn. */
function ChoiceRow({ label, testId, choices, value, disabled, format, onChoose }: {
  label: string;
  testId: string;
  choices: number[];
  value: number | null;
  disabled: boolean;
  format?: (choice: number) => string;
  onChoose: (choice: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-lg border border-line bg-ink p-0.5" role="radiogroup" aria-label={label} data-testid={testId}>
      {choices.map((choice) => (
        <button
          key={choice}
          type="button"
          role="radio"
          aria-checked={value === choice}
          disabled={disabled || value === null}
          className={`min-w-9 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
            value === choice ? "bg-white/10 text-snow" : "text-mist hover:text-snow"
          }`}
          onClick={() => onChoose(choice)}
        >
          {format ? format(choice) : choice}
        </button>
      ))}
    </div>
  );
}

/**
 * How many responsibilities may run at once on this Mac. Runs past the limit
 * wait in line and start by themselves; OpenWork Cloud schedules its own runs.
 */
function LocalRunsCard({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<CoworkerSettings | null>(null);
  const [status, setStatus] = useState<LocalRunStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      try {
        const [nextSettings, nextStatus] = await Promise.all([
          coworkerBridge.settings.get(),
          coworkerBridge.localResponsibilities.status(),
        ]);
        if (cancelled) return;
        setSettings(nextSettings);
        setStatus(nextStatus);
        setError("");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);

  async function choose(patch: Partial<CoworkerSettings>) {
    setSaving(true);
    setError("");
    try {
      setSettings(await coworkerBridge.settings.update(patch));
      setStatus(await coworkerBridge.localResponsibilities.status());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const limit = settings?.maxParallelLocalRuns ?? null;
  const live = status
    ? `${status.active} running · ${status.queued} waiting`
    : "";

  return (
    <SettingsCard testId="local-runs-card">
      <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-snow">Runs on this Mac</h3>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-mist">
            Scheduled assignments and Worker turns run up to this many at the same time. Any others wait in line and start by
            themselves when a run finishes. OpenWork Cloud schedules its own runs and is not limited here.
          </p>
          {live ? <p className="mt-2 text-[11px] text-mist" data-testid="local-runs-live">{live}</p> : null}
          {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
        </div>
        <ChoiceRow
          label="Runs at the same time"
          testId="local-runs-limit"
          choices={PARALLEL_CHOICES}
          value={limit}
          disabled={saving}
          onChoose={(choice) => void choose({ maxParallelLocalRuns: choice })}
        />
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4 border-t border-line px-4 py-4" data-testid="schedule-guardrails">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-snow">How often one assignment may run</h3>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-mist">
            A schedule a coworker sets up itself, or one you add, is refused when its runs would be closer together than this or more than this in a day.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-mist">At least</span>
            <ChoiceRow
              label="Minimum minutes between runs"
              testId="minimum-run-gap"
              choices={GAP_CHOICES}
              value={settings?.minimumRunGapMinutes ?? null}
              disabled={saving}
              format={(choice) => `${choice} min`}
              onChoose={(choice) => void choose({ minimumRunGapMinutes: choice })}
            />
            <span className="text-[11px] text-mist">apart</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-mist">At most</span>
            <ChoiceRow
              label="Most runs per assignment per day"
              testId="max-runs-per-day"
              choices={PER_DAY_CHOICES}
              value={settings?.maxRunsPerDay ?? null}
              disabled={saving}
              onChoose={(choice) => void choose({ maxRunsPerDay: choice })}
            />
            <span className="text-[11px] text-mist">a day</span>
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
