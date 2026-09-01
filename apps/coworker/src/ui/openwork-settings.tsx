import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { createCoworkerThreads, type EngineModelOption } from "@/lib/threads";
import { CoworkerMark, InlineLoader } from "@/ui/brand";
import { Button, ErrorNote, StatusDot } from "@/ui/kit";

type SettingsSection = "general" | "account" | "models" | "engine";

const SECTIONS: Array<{ id: SettingsSection; label: string; detail: string }> = [
  { id: "general", label: "General", detail: "Open Coworker and shared defaults" },
  { id: "account", label: "Account", detail: "OpenWork Cloud and organization" },
  { id: "models", label: "Models & providers", detail: "Shared engine catalog" },
  { id: "engine", label: "Local engine", detail: "Runtime and local storage" },
];

function sectionTitle(section: SettingsSection): string {
  return SECTIONS.find((item) => item.id === section)?.label ?? "Settings";
}

function sectionDescription(section: SettingsSection): string {
  return SECTIONS.find((item) => item.id === section)?.detail ?? "OpenWork configuration";
}

function modelLabel(coworker: CoworkerSummary, models: EngineModelOption[]): string {
  if (!coworker.model) return "OpenWork engine default";
  return models.find((model) => model.id === coworker.model)?.label ?? coworker.model;
}

function SettingsRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-start gap-5 border-t border-line px-4 py-3.5 first:border-t-0">
      <span className="w-36 shrink-0 text-xs font-medium text-mist">{label}</span>
      <span className="min-w-0 flex-1 text-right">
        <span className="block truncate text-xs font-medium text-snow" title={value}>{value}</span>
        {hint ? <span className="mt-0.5 block text-[11px] leading-relaxed text-mist">{hint}</span> : null}
      </span>
    </div>
  );
}

function SettingsCard({ children }: { children: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border border-line bg-panel/45">{children}</section>;
}

export function OpenWorkSettings({
  runtime,
  session,
  coworkers,
  selectedCoworker,
  onClose,
  onConnect,
  onSignOut,
  onRefreshRuntime,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  selectedCoworker: CoworkerSummary | null;
  onClose: () => void;
  onConnect: () => void;
  onSignOut: () => void;
  onRefreshRuntime: () => Promise<void>;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [models, setModels] = useState<EngineModelOption[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
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

  const refreshConfiguration = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      await onRefreshRuntime();
      setModels(threads && runtime.engineManaged ? await threads.listModels() : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }, [onRefreshRuntime, runtime.engineManaged, threads]);

  useEffect(() => {
    void refreshConfiguration();
  }, [refreshConfiguration]);

  const providers = Array.from(
    models.reduce((byProvider, model) => {
      const provider = byProvider.get(model.providerId) ?? { label: model.providerLabel, models: [] };
      provider.models.push(model);
      byProvider.set(model.providerId, provider);
      return byProvider;
    }, new Map<string, { label: string; models: EngineModelOption[] }>()),
  );

  return (
    <div className="window-shell flex h-full min-h-0 bg-ink" data-testid="openwork-settings">
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
            <h1 className="text-[15px] font-semibold text-snow">{sectionTitle(section)}</h1>
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
                    <p className="mt-2 text-xs text-mist">{session?.orgName || session?.userEmail || "Local mode · connect when you want cloud work"}</p>
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
                  <SettingsRow label="Models" value={models.length > 0 ? `${models.length} available` : runtime.engineManaged ? "Reading catalog" : "Unavailable"} hint="Provider connections are shared; model choices remain per coworker." />
                  <SettingsRow label="Storage" value={runtime.coworkersDir} hint="Identity and memory remain visible on this Mac." />
                </SettingsCard>
                <SettingsCard>
                  {coworkers.map((coworker) => (
                    <SettingsRow
                      key={coworker.slug}
                      label={coworker.name}
                      value={modelLabel(coworker, models)}
                      hint={coworker.modelVariant ? `Reasoning · ${coworker.modelVariant}` : "Coworker model preference"}
                    />
                  ))}
                </SettingsCard>
              </>
            ) : null}

            {section === "account" ? (
              <>
                <div>
                  <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">OpenWork account</h2>
                  <p className="mt-1 text-sm leading-relaxed text-mist">Connect once for shared organization settings and always-on cloud responsibilities.</p>
                </div>
                <SettingsCard>
                  <div className="flex items-center gap-4 p-5">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-line bg-ink"><StatusDot tone={session ? "mint" : "mist"} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-snow">{session ? "OpenWork connected" : "Local mode"}</span>
                      <span className="mt-1 block truncate text-xs text-mist">{session?.orgName || session?.userEmail || "No account is required for local coworkers."}</span>
                    </span>
                    {session ? <Button variant="ghost" onClick={onSignOut}>Sign out</Button> : <Button variant="primary" onClick={onConnect}>Connect</Button>}
                  </div>
                  {session ? (
                    <div className="border-t border-line px-5 py-4">
                      <button className="text-xs font-medium text-spark hover:underline" onClick={() => void coworkerBridge.openExternal(session.baseUrl)}>Open OpenWork in browser ↗</button>
                    </div>
                  ) : null}
                </SettingsCard>
              </>
            ) : null}

            {section === "models" ? (
              <>
                <div className="flex items-start justify-between gap-5">
                  <div>
                    <h2 className="text-xl font-semibold tracking-[-0.03em] text-snow">Models & providers</h2>
                    <p className="mt-1 max-w-xl text-sm leading-relaxed text-mist">The catalog is read live from the shared OpenWork engine. Choose a model for an individual teammate from that coworker’s settings.</p>
                  </div>
                  <Button variant="ghost" disabled={refreshing} onClick={() => void refreshConfiguration()}>{refreshing ? "Refreshing…" : "Refresh"}</Button>
                </div>
                {refreshing && models.length === 0 ? <div className="py-10"><InlineLoader label="Reading OpenWork models" /></div> : null}
                {!refreshing && providers.length === 0 ? (
                  <SettingsCard><p className="p-5 text-sm leading-relaxed text-mist">No connected provider models are available. Connect a provider in OpenWork, then refresh this catalog.</p></SettingsCard>
                ) : null}
                <div className="space-y-3">
                  {providers.map(([providerId, provider]) => (
                    <SettingsCard key={providerId}>
                      <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                        <span>
                          <span className="block text-sm font-semibold text-snow">{provider.label}</span>
                          <span className="mt-0.5 block text-[11px] text-mist">{providerId}</span>
                        </span>
                        <span className="rounded-full border border-line px-2.5 py-1 text-[10px] font-medium text-mist">{provider.models.length} model{provider.models.length === 1 ? "" : "s"}</span>
                      </div>
                    </SettingsCard>
                  ))}
                </div>
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
                  <SettingsRow label="Status" value={runtime.engineManaged ? "Running" : "Unavailable"} hint={runtime.engineManaged ? "Managed locally by Open Coworker" : runtime.engineError || "The local agent engine is offline."} />
                  <SettingsRow label="Application" value={`${runtime.appName} ${runtime.version}`} />
                  <SettingsRow label="Coworker home" value={runtime.coworkersDir} hint="Local identities, memory, and responsibility definitions." />
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
