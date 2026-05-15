/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Building2,
  Check,
  Cloud,
  Loader2,
  Puzzle,
  Server,
} from "lucide-react";

import {
  createDenClient,
  readDenSettings,
  resolveDenBaseUrls,
  writeDenSettings,
  type DenOrgLlmProvider,
  type DenOrgMarketplace,
  type DenOrgSummary,
  type DenWorkerSummary,
} from "../../../app/lib/den";
import { usePlatform } from "../../kernel/platform";
import { resolveModelDisplayName, resolveProviderDisplayName } from "../../../app/utils";
import { ProviderIcon } from "../../design-system/provider-icon";
import { writeStoredDefaultModel } from "../../kernel/model-config";
import { orgOnboardingVisibilityEvent, useReloadCoordinator } from "../../shell/reload-coordinator";
import { dispatchNewProviders } from "../../../app/lib/provider-events";

const RELOAD_AFTER_ONBOARDING_KEY = "openwork.reloadAfterOrgOnboarding";



type OrgResources = {
  providers: DenOrgLlmProvider[];
  marketplaces: DenOrgMarketplace[];
  workers: DenWorkerSummary[];
};

/**
 * Full-screen onboarding page shown after sign-in + org selection.
 * Fetches all org resources (providers, marketplaces, workers, skills)
 * and shows them so the user knows what their org provides.
 *
 * Route: /onboarding
 */
export function OrgOnboardingPage() {
  const navigate = useNavigate();
  const platform = usePlatform();
  const reloadCoordinator = useReloadCoordinator();
  const [settings, setSettings] = useState(() => readDenSettings());
  const orgId = settings.activeOrgId?.trim() ?? "";
  const orgName = settings.activeOrgName?.trim() ?? "";
  const authToken = settings.authToken?.trim() ?? "";

  const [orgs, setOrgs] = useState<DenOrgSummary[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState(orgId);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [orgSwitchBusy, setOrgSwitchBusy] = useState(false);
  const [orgSelectionConfirmed, setOrgSelectionConfirmed] = useState(false);
  const [resources, setResources] = useState<OrgResources>({
    providers: [],
    marketplaces: [],
    workers: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDefault, setSelectedDefault] = useState<{
    providerId: string;
    modelId: string;
    label: string;
  } | null>(null);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(orgOnboardingVisibilityEvent, { detail: { visible: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent(orgOnboardingVisibilityEvent, { detail: { visible: false } }));
    };
  }, []);

  // Redirect if no auth — can't show onboarding without a signed-in session.
  useEffect(() => {
    if (!authToken) {
      navigate("/session", { replace: true });
    }
  }, [authToken, navigate]);

  // Load organizations before fetching org resources. If the user belongs to
  // multiple orgs, require an explicit choice so we don't import the wrong org.
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;

    const client = createDenClient({
      baseUrl: settings.baseUrl,
      apiBaseUrl: settings.apiBaseUrl,
      token: authToken,
    });

    setOrgsLoading(true);
    void client.listOrgs()
      .then((response) => {
        if (cancelled) return;
        setOrgs(response.orgs);
        const preferred =
          response.orgs.find((org) => org.id === orgId) ??
          response.orgs.find((org) => org.id === response.activeOrgId) ??
          response.orgs[0] ??
          null;
        setSelectedOrgId(preferred?.id ?? "");
        if (response.orgs.length <= 1) {
          if (preferred) {
            const nextSettings = {
              ...settings,
              authToken,
              activeOrgId: preferred.id,
              activeOrgSlug: preferred.slug,
              activeOrgName: preferred.name,
            };
            writeDenSettings(nextSettings, { persistBootstrap: false });
            setSettings(nextSettings);
            void client.setActiveOrganization({ organizationId: preferred.id }).catch(() => undefined);
          } else {
            setLoading(false);
          }
          setOrgSelectionConfirmed(true);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load organizations");
      })
      .finally(() => {
        if (!cancelled) setOrgsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, orgId, settings.apiBaseUrl, settings.baseUrl]);

  const confirmOrgSelection = useCallback(async () => {
    if (!authToken || !selectedOrgId || orgSwitchBusy) return;
    const nextOrg = orgs.find((org) => org.id === selectedOrgId) ?? null;
    if (!nextOrg) return;

    setOrgSwitchBusy(true);
    setError(null);
    try {
      const client = createDenClient({
        baseUrl: settings.baseUrl,
        apiBaseUrl: settings.apiBaseUrl,
        token: authToken,
      });
      await client.setActiveOrganization({ organizationId: nextOrg.id });
      const nextSettings = {
        ...settings,
        authToken,
        activeOrgId: nextOrg.id,
        activeOrgSlug: nextOrg.slug,
        activeOrgName: nextOrg.name,
      };
      writeDenSettings(nextSettings, { persistBootstrap: false });
      setSettings(nextSettings);
      setResources({ providers: [], marketplaces: [], workers: [] });
      setSelectedDefault(null);
      setOrgSelectionConfirmed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select organization");
    } finally {
      setOrgSwitchBusy(false);
    }
  }, [authToken, orgSwitchBusy, orgs, selectedOrgId, settings]);

  // Fetch all org resources in parallel
  useEffect(() => {
    const resourceOrgId = orgId || selectedOrgId;
    if (!authToken || !resourceOrgId || !orgSelectionConfirmed) return;
    let cancelled = false;

    const client = createDenClient({
      baseUrl: settings.baseUrl,
      apiBaseUrl: settings.apiBaseUrl,
      token: authToken,
    });

    setLoading(true);
    setError(null);
    void Promise.all([
      client.listOrgLlmProviders(resourceOrgId).catch(() => [] as DenOrgLlmProvider[]),
      client.listOrgMarketplaces(resourceOrgId).catch(() => [] as DenOrgMarketplace[]),
      client.listWorkers(resourceOrgId).catch(() => [] as DenWorkerSummary[]),
    ])
      .then(([providers, marketplaces, workers]) => {
        if (cancelled) return;
        setResources({ providers, marketplaces, workers });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, orgId, orgSelectionConfirmed, selectedOrgId, settings.apiBaseUrl, settings.baseUrl]);

  const handleContinue = useCallback(() => {
    // If user picked a default model, write it
    if (selectedDefault) {
      writeStoredDefaultModel({
        providerID: selectedDefault.providerId,
        modelID: selectedDefault.modelId,
      });
    }
    if (reloadCoordinator.reloadPending || resources.providers.length > 0) {
      try {
        window.localStorage.setItem(RELOAD_AFTER_ONBOARDING_KEY, "1");
      } catch {}
    }
    if (resources.providers.length > 0) {
      dispatchNewProviders({
        source: "sign_in",
        providers: resources.providers.map((provider) => {
          const firstModel = provider.models[0] ?? null;
          return {
            id: provider.id,
            name: provider.name,
            providerId: provider.providerId,
            firstModelId: firstModel?.id,
            firstModelName: firstModel?.name ?? firstModel?.id,
          };
        }),
      });
    }
    navigate("/session", { replace: true });
  }, [navigate, reloadCoordinator.reloadPending, resources.providers, selectedDefault]);

  const { providers, marketplaces, workers } = resources;
  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);
  const hasResources = providers.length > 0 || marketplaces.length > 0 || workers.length > 0;
  const needsOrgSelection = orgs.length > 1 && !orgSelectionConfirmed;
  const selectedOrg = orgs.find((org) => org.id === selectedOrgId) ?? null;

  return (
    <div className="relative h-screen overflow-y-auto bg-dls-background text-dls-text">
      {/* Background texture */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-[20%] -top-[30%] h-[70%] w-[60%] rounded-full bg-[radial-gradient(ellipse,rgba(14,51,217,0.06),transparent_70%)] blur-3xl" />
        <div className="absolute -bottom-[20%] -right-[10%] h-[50%] w-[50%] rounded-full bg-[radial-gradient(ellipse,rgba(255,126,46,0.05),transparent_70%)] blur-3xl" />
        <div className="absolute left-[30%] top-[60%] h-[40%] w-[40%] rounded-full bg-[radial-gradient(ellipse,rgba(255,227,64,0.04),transparent_70%)] blur-3xl" />
      </div>

      {/* Titlebar drag region */}
      <div className="fixed inset-x-0 top-0 z-20 h-10 mac:titlebar-drag" />

      <div className="relative z-10 px-6 py-16">
        <div className="mx-auto w-full max-w-lg space-y-8">
          {/* Header */}
          <div className="space-y-3 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover">
              <Building2 size={28} className="text-dls-text" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-dls-text">
              {needsOrgSelection ? "Choose your organization" : orgName || selectedOrg?.name || "Your organization"}
            </h1>
            {orgsLoading ? (
              <p className="text-sm text-dls-secondary">Loading organizations...</p>
            ) : needsOrgSelection ? (
              <p className="text-sm text-dls-secondary">Select the org whose resources should be added to this workspace.</p>
            ) : loading ? (
              <p className="text-sm text-dls-secondary">Loading available resources...</p>
            ) : error ? (
              <p className="text-sm text-red-11">{error}</p>
            ) : hasResources ? (
              <p className="text-sm text-dls-secondary">
                You have access to the following resources.
              </p>
            ) : null}
          </div>

          {orgsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={24} className="animate-spin text-dls-secondary" />
            </div>
          ) : needsOrgSelection ? (
            <div className="space-y-3">
              {orgs.map((org) => {
                const selected = org.id === selectedOrgId;
                return (
                  <button
                    key={org.id}
                    type="button"
                    className={`flex w-full items-center gap-3 rounded-xl border bg-dls-surface px-4 py-3 text-left transition-colors ${
                      selected ? "border-green-6" : "border-dls-border hover:bg-dls-hover"
                    }`}
                    onClick={() => setSelectedOrgId(org.id)}
                  >
                    <Building2 size={18} className="shrink-0 text-dls-secondary" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-dls-text">{org.name}</div>
                      <div className="mt-0.5 text-xs text-dls-secondary">{org.slug}</div>
                    </div>
                    {selected ? <Check size={16} className="shrink-0 text-green-11" /> : null}
                  </button>
                );
              })}
              {error ? <p className="text-center text-sm text-red-11">{error}</p> : null}
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-dls-accent px-8 text-sm font-semibold text-[var(--dls-accent-fg)] transition-all hover:bg-[var(--dls-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void confirmOrgSelection()}
                  disabled={!selectedOrgId || orgSwitchBusy}
                >
                  {orgSwitchBusy ? <Loader2 size={16} className="animate-spin" /> : null}
                  Continue with {selectedOrg?.name ?? "organization"}
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>
          ) : loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={24} className="animate-spin text-dls-secondary" />
            </div>
          ) : !hasResources ? (
            <div className="rounded-2xl border border-dls-border bg-dls-surface px-6 py-10 text-center">
              <p className="text-sm text-dls-secondary">
                No resources have been configured for this organization yet.
              </p>
              <p className="mt-2 text-xs text-dls-secondary">
                Add AI providers, marketplaces, or workers from the{" "}
                <button
                  type="button"
                  className="font-medium text-dls-text underline underline-offset-2"
                  onClick={() => platform.openLink(resolveDenBaseUrls(settings.baseUrl).baseUrl)}
                >
                  OpenWork Cloud dashboard
                </button>
                .
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* AI Providers */}
              {providers.length > 0 ? (
                <Section
                  icon={<Cloud size={16} />}
                  title="AI Providers"
                  description="Models you can use in your workspace."
                  count={totalModels > 0 ? `${totalModels} model${totalModels === 1 ? "" : "s"}` : null}
                >
                  {providers.map((provider) => (
                    <ProviderCard
                      key={provider.id}
                      provider={provider}
                      selectedDefault={selectedDefault}
                      onSelectDefault={setSelectedDefault}
                    />
                  ))}
                </Section>
              ) : null}

              {/* Marketplaces */}
              {marketplaces.length > 0 ? (
                <Section
                  icon={<Puzzle size={16} />}
                  title="Marketplaces"
                  description="App stores with extensions and plugins for your workspace."
                  count={`${marketplaces.length} marketplace${marketplaces.length === 1 ? "" : "s"}`}
                >
                  {marketplaces.map((mp) => (
                    <div key={mp.id} className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
                      <Puzzle size={16} className="shrink-0 text-dls-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-dls-text">{mp.name}</div>
                        {mp.description ? (
                          <div className="mt-0.5 truncate text-xs text-dls-secondary">{mp.description}</div>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-xs text-dls-secondary">{mp.pluginCount} plugin{mp.pluginCount === 1 ? "" : "s"}</span>
                    </div>
                  ))}
                </Section>
              ) : null}

              {/* Workers */}
              {workers.length > 0 ? (
                <Section
                  icon={<Server size={16} />}
                  title="Cloud Workers"
                  description="Remote machines that can run tasks for you."
                  count={`${workers.length} worker${workers.length === 1 ? "" : "s"}`}
                >
                  {workers.map((worker) => (
                    <div key={worker.workerId} className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
                      <Server size={16} className="shrink-0 text-dls-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-dls-text">{worker.workerName}</div>
                        <div className="mt-0.5 text-xs text-dls-secondary">
                          {worker.status}{worker.provider ? ` · ${worker.provider}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </Section>
              ) : null}
            </div>
          )}

          {/* Selected default indicator */}
          {selectedDefault ? (
            <div className="rounded-xl border border-green-6/30 bg-green-2/30 px-4 py-3 text-center text-sm text-green-11">
              <Check size={14} className="mr-1 inline" />
              {selectedDefault.label} will be set as your default model.
            </div>
          ) : null}

          {/* Footer hint */}
          {!needsOrgSelection && !loading && hasResources ? (
            <p className="text-center text-xs text-dls-secondary">
              Providers are added to your workspace automatically. Marketplaces and workers are available from Cloud settings.
            </p>
          ) : null}

          {/* Continue button */}
          {!needsOrgSelection ? <div className="flex justify-center pt-2">
            <button
              type="button"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-dls-accent px-8 text-sm font-semibold text-[var(--dls-accent-fg)] transition-all hover:bg-[var(--dls-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleContinue}
              disabled={loading}
            >
              {hasResources ? "Continue to workspace" : "Continue"}
              <ArrowRight size={16} />
            </button>
          </div> : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

function Section({
  icon,
  title,
  description,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  count: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div>
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-dls-secondary">
          {icon}
          {title}
          {count ? <span className="text-dls-secondary/60">{count}</span> : null}
        </div>
        <div className="mt-0.5 pl-6 text-xs text-dls-secondary/80">{description}</div>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider card with "Use as default" option                         */
/* ------------------------------------------------------------------ */

function ProviderCard({
  provider,
  selectedDefault,
  onSelectDefault,
}: {
  provider: DenOrgLlmProvider;
  selectedDefault: { providerId: string; modelId: string } | null;
  onSelectDefault: (v: { providerId: string; modelId: string; label: string } | null) => void;
}) {
  // The local provider ID matches the cloud provider's org-level ID
  const localProviderId = provider.id.trim();
  const firstModel = provider.models[0] ?? null;
  const isSelected = selectedDefault?.providerId === localProviderId;

  const handleUseAsDefault = () => {
    if (!firstModel) return;
    if (isSelected) {
      onSelectDefault(null);
    } else {
      onSelectDefault({
        providerId: localProviderId,
        modelId: firstModel.id,
        label: `${resolveProviderDisplayName(provider.name || provider.providerId)} · ${firstModel.name || resolveModelDisplayName(firstModel.id)}`,
      });
    }
  };

  return (
    <div
      className={`rounded-xl border bg-dls-surface px-4 py-3 transition-colors ${
        isSelected ? "border-green-6" : "border-dls-border"
      }`}
    >
      <div className="flex items-center gap-3">
        <ProviderIcon
          providerId={provider.providerId}
          providerName={provider.name}
          size={20}
          className="text-dls-text"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-dls-text">
            {resolveProviderDisplayName(provider.name || provider.providerId)}
          </div>
          {provider.models.length > 0 ? (
            <div className="mt-0.5 text-xs text-dls-secondary">
              {provider.models.length === 1
                ? "1 model"
                : `${provider.models.length} models`}
            </div>
          ) : null}
        </div>
        {firstModel ? (
          <button
            type="button"
            className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
              isSelected
                ? "bg-green-3 text-green-11"
                : "border border-dls-border text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
            }`}
            onClick={handleUseAsDefault}
          >
            {isSelected ? "Default" : "Use as default"}
          </button>
        ) : (
          <Check size={16} className="shrink-0 text-green-11" />
        )}
      </div>
      {provider.models.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {provider.models.slice(0, 5).map((model) => (
            <span
              key={model.id}
              className="inline-flex items-center rounded-md border border-dls-border bg-dls-hover px-2 py-0.5 font-mono text-[10px] text-dls-secondary"
            >
              {model.name || resolveModelDisplayName(model.id)}
            </span>
          ))}
          {provider.models.length > 5 ? (
            <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] text-dls-secondary">
              +{provider.models.length - 5} more
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
