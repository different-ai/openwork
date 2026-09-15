import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssignedCoworkers } from "@/ui/assigned-coworkers";
import {
  coworkerBridge,
  type CoworkerSettings,
  type CoworkerSummary,
  type LocalRunStatus,
  type ProviderSyncRun,
  type RuntimeInfo,
} from "@/lib/bridge";
import { buildDenAccountUrl, denApiBase, describeSkippedProvider, type DenSession } from "@/lib/den";
import {
  createCoworkerThreads,
  modelOriginLabel,
  type EngineModelCatalog,
  type EngineModelOption,
  type ProgressModelOption,
} from "@/lib/threads";
import { PROGRESS_LIMITS } from "@/lib/progress-config";
import { carryVariant, clearAutoPicked } from "@/lib/model-choice";
import { effortStopLabel } from "@/lib/effort";
import { usesAppConversationDefault } from "@/lib/model-defaults";
import { AppModelDefaults } from "@/ui/app-model-defaults";
import { CoworkerModelSettings } from "@/ui/coworker-model-settings";
import { CoworkerMark, InlineLoader } from "@/ui/brand";
import { Button, ErrorNote, StatusDot } from "@/ui/kit";
import { LocalProviders } from "@/ui/local-providers";
import { ModelsMembershipCard } from "@/ui/models-membership";
import { FreshStartSettings } from "@/ui/fresh-start-settings";

export type SettingsSection = "general" | "model-defaults" | "account" | "models" | "engine" | "fresh-start";

const SECTIONS: Array<{ id: SettingsSection; label: string; detail: string }> = [
  { id: "general", label: "General", detail: "Coworker models, effort and activity preferences" },
  { id: "model-defaults", label: "Model defaults", detail: "Shared models for conversation, Workers and chat turn assignment" },
  { id: "account", label: "Account", detail: "OpenWork account and organization" },
  { id: "models", label: "AI models", detail: "What every coworker can use: your OpenWork account, this Mac, and OpenWork's free model" },
  { id: "engine", label: "AI & local setup", detail: "AI service, responsibilities on this Mac, and storage" },
  { id: "fresh-start", label: "Fresh start", detail: "A tour, a tune-up, or a new beginning" },
];

const EMPTY_CATALOG: EngineModelCatalog = { models: [], connectedProviderIds: [], cloud: null };

function sectionTitle(section: SettingsSection): string {
  return SECTIONS.find((item) => item.id === section)?.label ?? "Settings";
}

function sectionDescription(section: SettingsSection): string {
  return SECTIONS.find((item) => item.id === section)?.detail ?? "OpenWork configuration";
}

function modelLabel(coworker: CoworkerSummary, models: EngineModelOption[], catalogLoaded: boolean): string {
  if (usesAppConversationDefault(coworker)) return "App conversation default";
  if (!coworker.model) return "No model selected yet";
  const match = models.find((model) => model.id === coworker.model);
  if (match) return `${match.label} · ${modelOriginLabel(match)}`;
  return catalogLoaded ? `${coworker.model} · unavailable` : coworker.model;
}

function modelHint(coworker: CoworkerSummary): string {
  if (usesAppConversationDefault(coworker)) return "Shared model and effort from Settings > Model defaults";
  const mode = coworker.modelMode === "auto" ? "Automatic model selection" : "Selected model for every message";
  return `${mode} · ${coworker.modelVariant ? `Fixed effort: ${coworker.modelVariant}` : `Adaptive effort: ${effortStopLabel(coworker.effortPreference)}`}`;
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

function SettingsRow({ label, value, hint, tone, action }: { label: string; value: string; hint?: string; tone?: "mint" | "amber" | "rose" | "mist"; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-5 border-t border-line px-4 py-3.5 first:border-t-0">
      <span className="w-36 shrink-0 text-xs font-medium text-mist">{label}</span>
      <span className="min-w-0 flex-1 text-right">
        <span className="flex items-center justify-end gap-2">
          {tone ? <StatusDot tone={tone} /> : null}
          <span className="block truncate text-xs font-medium text-snow" title={value}>{value}</span>
        </span>
        {hint ? <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">{hint}</span> : null}
        {action ? <span className="mt-2 block">{action}</span> : null}
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
  templateSync,
  templateError,
  onSyncTemplates,
  onImportedTemplates,
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
  onReplayOnboarding,
  onFactoryReset,
}: {
  onReplayOnboarding: () => void;
  onFactoryReset: () => void;
  active?: boolean;
  runtime: RuntimeInfo;
  session: DenSession | null;
  /** Outcome of the most recent account provider sync this session, if any. */
  providerSync: ProviderSyncRun | null;
  templateSync: import("@/lib/bridge").CoworkerTemplateSync | null;
  templateError: string;
  onSyncTemplates: (installIds?: string[]) => Promise<void>;
  onImportedTemplates: (result: import("@/lib/bridge").CoworkerTemplateSync) => void;
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
  const [editingCoworker, setEditingCoworker] = useState("");
  useEffect(() => {
    if (active && session && section === "account") void onSyncTemplates();
  }, [active, session, section, onSyncTemplates]);
  async function chooseModelFor(coworker: CoworkerSummary, modelId: string) {
    setError("");
    try {
      clearAutoPicked(coworker.slug);
      onCoworkerChanged?.(await coworkerBridge.coworkers.update(coworker.slug, { model: modelId, modelVariant: carryVariant(coworker.modelVariant, catalog.models.find((model) => model.id === modelId)), modelChosenBy: "person" }));
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
    <div className="flex h-full min-h-0 flex-1 bg-ink" data-testid="openwork-settings" onKeyDown={(event) => {
      if (active && section === "fresh-start" && event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); }
    }}>
      <aside className="glass-rail hidden h-full w-[200px] shrink-0 flex-col border-r border-line sm:flex lg:w-[252px]" data-testid="openwork-settings-sidebar">
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
        <div className="window-drag h-8 shrink-0 sm:hidden" />
        <header className="glass-header window-drag flex min-h-[62px] shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-7">
          <div className="min-w-0 flex-1">
            <h1 ref={headingRef} tabIndex={-1} className="text-[15px] font-semibold text-snow outline-none">{sectionTitle(section)}</h1>
            <p className="mt-0.5 text-[11px] text-mist">{sectionDescription(section)}</p>
          </div>
          <Button variant="ghost" className="window-no-drag size-8 px-0" onClick={onClose} title="Close settings" aria-label="Close settings">×</Button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[760px] space-y-6">
            <label className="block sm:hidden">
              <span className="sr-only">Settings section</span>
              <select className="w-full min-w-0 rounded-xl border border-line bg-panel p-2 text-sm text-snow" value={section} onChange={(event) => {
                const next = SECTIONS.find((item) => item.id === event.target.value);
                if (next) setSection(next.id);
              }}>
                {SECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            {section === "fresh-start" ? <FreshStartSettings onReplay={onReplayOnboarding} onFactoryReset={onFactoryReset} /> : null}
            {section === "model-defaults" ? <AppModelDefaults active={active} runtime={runtime} session={session} catalog={catalog} catalogLoaded={catalogLoaded} catalogLoading={refreshing} onRefreshCatalog={refreshConfiguration} onOpenModels={() => setSection("models")} /> : null}
            {section === "general" ? (
              <>
                <div>
                  <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">OpenWork settings</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-relaxed text-mist">
                    Connections and model defaults are shared across your team. Keep those defaults or customize a coworker's model and effort here or in its sidebar.
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
                <button type="button" className="block w-full rounded-2xl border border-line bg-panel/45 p-4 text-left transition-colors hover:bg-white/[0.045]" onClick={() => setSection("model-defaults")}>
                  <span className="text-sm font-semibold text-snow">Model defaults</span>
                  <span className="mt-1 block text-xs leading-relaxed text-mist">Conversation, Deep thinking, Delivery and Chat turn assignment. Set shared choices once; individual overrides still win.</span>
                </button>
                <SettingsCard>
                  <SettingsRow label="Coworkers" value={`${coworkers.length} coworker${coworkers.length === 1 ? "" : "s"}`} hint="Each coworker has its own OpenWork workspace." />
                  <SettingsRow
                    label="AI models"
                    value={models.length > 0 ? `${models.length} available` : runtime.engineManaged ? (refreshing ? "Reading models" : "None connected") : "Unavailable"}
                    hint={models.length > 0 ? `${cloudProviders.length} OpenWork Cloud provider${cloudProviders.length === 1 ? "" : "s"} · ${localProviders.length} on this Mac` : "Provider connections are shared. Choose shared models in Model defaults or customize a coworker."}
                  />
                </SettingsCard>
                {coworkers.length > 0 ? (
                  <section className="space-y-3" data-testid="coworker-defaults">
                    <h2 className="text-sm font-semibold text-snow">Models and effort by coworker</h2>
                    <p className="text-xs leading-relaxed text-mist">Use the app conversation default or keep a personal model. Changes below apply only to the coworker you edit; saved personal choices are kept when you switch to app defaults.</p>
                    <SettingsCard>
                      {coworkers.map((coworker) => (
                        <details key={coworker.slug} open={editingCoworker === coworker.slug} onToggle={(event) => {
                          const open = event.currentTarget.open;
                          setEditingCoworker((current) => open ? coworker.slug : current === coworker.slug ? "" : current);
                        }} className="border-t border-line first:border-t-0" data-testid={`coworker-defaults-${coworker.slug}`}>
                          <summary className="flex cursor-pointer flex-wrap items-start justify-between gap-3 p-4 text-xs text-snow">
                            <span className="min-w-0 flex-1">
                              <span className="block font-semibold">{coworker.name}</span>
                              <span className="mt-1 block break-words">{modelLabel(coworker, models, catalogLoaded)}</span>
                              <span className="mt-1 block leading-relaxed text-mist">{modelHint(coworker)}</span>
                            </span>
                            <span className="shrink-0 text-spark">Edit models & effort</span>
                          </summary>
                          {editingCoworker === coworker.slug && onCoworkerChanged ? <div className="border-t border-line p-4">
                            <CoworkerModelSettings runtime={runtime} session={session} coworker={coworker} onCoworkerChanged={onCoworkerChanged} onSyncProviders={onSyncProviders} onOpenAccount={() => setSection("account")} onOpenModelDefaults={() => setSection("model-defaults")} catalog={catalog} catalogLoading={refreshing} onRefreshCatalog={refreshConfiguration} />
                          </div> : null}
                        </details>
                      ))}
                    </SettingsCard>
                  </section>
                ) : null}
                <ProgressSummariesCard active={active} />
                <AutomaticMemoryCard active={active} />
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
                {session ? <SettingsCard>
                  <div className="p-5">
                    <h3 className="text-sm font-semibold text-snow">Connect the apps your work lives in</h3>
                    <p className="mt-1 text-xs leading-5 text-mist">Connect an app in OpenWork, then use Apps & tools in your coworker's settings to discover what it can do. Connections and their permissions are managed separately from Models membership.</p>
                    <Button className="mt-3" variant="ghost" onClick={() => {
                      void coworkerBridge.openExternal(buildDenAccountUrl(session.baseUrl, "connections")).catch(() => setError("Couldn't open your connected apps. Try again."));
                    }}>Manage connected apps</Button>
                  </div>
                </SettingsCard> : null}
                <AssignedCoworkers signedIn={Boolean(session)} result={templateSync} error={templateError} selected={selectedCoworker} onSync={onSyncTemplates} onImported={onImportedTemplates} />
              </>
            ) : null}

            {section === "models" ? (
              <>
                <ModelsMembershipCard
                  key={`${session?.baseUrl ?? runtime.denBaseUrl}:${session?.orgId ?? "signed-out"}:${session?.userEmail ?? ""}`}
                  session={session}
                  baseUrl={runtime.denBaseUrl}
                  onConnect={onConnect}
                  onRefreshModels={() => refreshConfiguration({ sync: true })}
                />
                <div className="flex items-start justify-between gap-5">
                  <div>
                    <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">AI models</h2>
                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-mist">
                      Connected models can be used across your team. Choose shared models in Model defaults, or customize one coworker in its settings. Catalog availability does not confirm paid access.
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
                  <SettingsRow label="Coworker files" value={runtime.coworkersDir} hint="Open the folder to browse each coworker's files and saved configuration." action={<Button variant="ghost" className="text-xs" onClick={() => {
                    setError("");
                    void coworkerBridge.coworkers.openFolder().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                  }}>Open folder</Button>} />
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

function ProgressSummariesCard({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<CoworkerSettings | null>(null);
  const [models, setModels] = useState<ProgressModelOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all([coworkerBridge.settings.get(), coworkerBridge.settings.progressModels()]).then(([next, choices]) => {
      if (!cancelled) { setSettings(next); setModels(choices); }
    }).catch(() => { if (!cancelled) setError("Progress preferences could not be read. Observed activity is still available."); });
    return () => { cancelled = true; };
  }, [active]);
  async function choose(patch: Partial<CoworkerSettings>) {
    setSaving(true);
    setError("");
    try { setSettings(await coworkerBridge.settings.update(patch)); }
    catch { setError("That preference could not be saved. Observed activity is still available."); }
    finally { setSaving(false); }
  }
  const selected = settings?.progressSummaryModelId ?? "";
  return <SettingsCard testId="progress-summaries-card">
    <div className="space-y-3 p-4">
      <label className="flex items-center justify-between gap-4 text-sm font-semibold text-snow">
        Progress summaries
        <input type="checkbox" aria-label="Enable progress summaries" checked={settings?.progressSummariesEnabled ?? false} disabled={!settings || saving} onChange={(event) => void choose({ progressSummariesEnabled: event.target.checked })} />
      </label>
      <p className="text-xs leading-relaxed text-mist">Use AI to summarize activity during long tasks. Leave this off to show activity without extra model calls. This model does not answer your messages or run Workers.</p>
      <p className="text-[11px] leading-relaxed text-mist">Only activity facts are sent. Private messages, reasoning, file contents and tool results are excluded.</p>
      <label className="block space-y-1 text-xs text-mist">
        <span>Summary model</span>
        <select aria-label="Progress summary model" className="block w-full min-w-0 rounded-lg border border-line bg-ink p-2 text-snow" value={selected} disabled={!settings || saving} onChange={(event) => void choose({ progressSummaryModelId: event.target.value })}>
          <option value="">No model selected</option>
          {selected && !models.some((model) => model.id === selected) ? <option value={selected} disabled>Selected model is not currently eligible</option> : null}
          {models.map((model) => <option key={model.id} value={model.id}>{model.label} (${model.cost.input} input / ${model.cost.output} output per million tokens)</option>)}
        </select>
      </label>
      <details className="text-[11px] leading-relaxed text-mist">
        <summary className="cursor-pointer">Model requirements and cost limits</summary>
        <p className="mt-2">Only connected text models with verified prices and output limits appear here. Reasoning models are excluded. Prices must be at most ${PROGRESS_LIMITS.maxInputPrice.toFixed(2)} input and ${PROGRESS_LIMITS.maxOutputPrice.toFixed(2)} output per million tokens. The app does not switch to another model if this one fails.</p>
        <p className="mt-2">At most {PROGRESS_LIMITS.maxCallsPerExecution} requests per task, {PROGRESS_LIMITS.minCallIntervalMs / 1000} seconds apart. Each request allows {PROGRESS_LIMITS.maxOutputTokens} output tokens and times out after {PROGRESS_LIMITS.timeoutMs / 1000} seconds.</p>
      </details>
      {!models.length ? <p className="text-xs text-mist">No eligible model is ready here yet. Models with missing price or capability information are not offered. Observed activity will continue normally.</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  </SettingsCard>;
}
function AutomaticMemoryCard({ active }: { active: boolean }) {
  const [settings, setSettings] = useState<CoworkerSettings | null>(null);
  const [models, setModels] = useState<ProgressModelOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all([coworkerBridge.settings.get(), coworkerBridge.settings.progressModels()]).then(([next, choices]) => {
      if (!cancelled) { setSettings(next); setModels(choices); setError(""); }
    }).catch(() => { if (!cancelled) setError("Automatic memory preferences could not be read."); });
    return () => { cancelled = true; };
  }, [active]);
  async function choose(patch: Partial<Pick<CoworkerSettings, "automaticMemoryEnabled" | "memoryModelId">>) {
    setSaving(true);
    setError("");
    try { setSettings(await coworkerBridge.settings.update(patch)); }
    catch { setError("That automatic memory preference could not be saved."); }
    finally { setSaving(false); }
  }
  const selected = settings?.memoryModelId ?? "";
  const missing = selected && !models.some((model) => model.id === selected);
  return <SettingsCard testId="automatic-memory-card">
    <div className="space-y-3 p-4">
      <label className="flex items-center justify-between gap-4 text-sm font-semibold text-snow">
        Automatic conversation memory
        <input type="checkbox" aria-label="Enable automatic memory" checked={settings?.automaticMemoryEnabled ?? true} disabled={!settings || saving} onChange={(event) => void choose({ automaticMemoryEnabled: event.target.checked })} />
      </label>
      <p className="text-xs leading-relaxed text-mist">On by default. After successful private and group replies, Open Coworker automatically keeps bounded recent conversation excerpts locally. It sends bounded excerpts and existing memory context to the selected model's provider to distill short-term and long-term memories.</p>
      <p className="text-[11px] leading-relaxed text-mist">Recent local recall works without an eligible model. This setting never changes the model that answers your messages. Read the excerpts, their sources, and summaries or clear a selected scope in each coworker's Memory view.</p>
      <label className="block space-y-1 text-xs text-mist">
        <span>Memory model</span>
        <select aria-label="Automatic memory model" className="block w-full min-w-0 rounded-lg border border-line bg-ink p-2 text-snow" value={selected} disabled={!settings || saving} onChange={(event) => void choose({ memoryModelId: event.target.value })}>
          <option value="">Automatic (cheapest eligible connected model)</option>
          {missing ? <option value={selected} disabled>{selected} (not currently eligible)</option> : null}
          {models.map((model) => <option key={model.id} value={model.id}>{model.label} (${model.cost.input} input / ${model.cost.output} output per million tokens)</option>)}
        </select>
      </label>
      {missing ? <p className="text-xs text-mist">The selected model is unavailable or ineligible. It will not be replaced automatically; recent local recall can continue while automatic memory is on.</p> : !models.length ? <p className="text-xs text-mist">No eligible model is ready. Recent local recall can continue while automatic memory is on, without summary calls.</p> : null}
      <details className="text-[11px] leading-relaxed text-mist">
        <summary className="cursor-pointer">Privacy, model requirements and limits</summary>
        <p className="mt-2">Private discussions and shared group memory are kept in separate scopes. Excerpts are bounded, not complete transcripts. Turning this off stops automatic capture and recall; it does not delete saved memory.</p>
        <p className="mt-2">Only eligible connected, non-reasoning text models with verified low prices are offered: at most $0.50 input and $2.00 output per million tokens. Automatic selects the cheapest eligible model; an explicit selection never falls back to a different model.</p>
        <p className="mt-2">At most 120 automatic memory calls total per UTC day across all scopes, at least 15 seconds apart for the same scope. Each request times out within 15 seconds and allows at most 1,000 output tokens.</p>
      </details>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  </SettingsCard>;
}

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
            Limit how many scheduled assignments and Worker turns run at once. Others wait for a free slot. Lower this if your Mac slows down. Cloud runs use separate limits.
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
            Set limits for local schedules to avoid running too often. New or edited schedules must meet both limits.
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
