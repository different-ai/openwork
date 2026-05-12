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
  Sparkles,
} from "lucide-react";

import {
  createDenClient,
  fetchDenOrgSkillsCatalog,
  readDenSettings,
  type DenOrgLlmProvider,
  type DenOrgMarketplace,
  type DenWorkerSummary,
} from "../../../app/lib/den";
import type { DenOrgSkillCard } from "../../../app/types";
import { resolveModelDisplayName, resolveProviderDisplayName } from "../../../app/utils";
import { ProviderIcon } from "../../design-system/provider-icon";
import { writeStoredDefaultModel } from "../../kernel/model-config";



type OrgResources = {
  providers: DenOrgLlmProvider[];
  marketplaces: DenOrgMarketplace[];
  workers: DenWorkerSummary[];
  skills: DenOrgSkillCard[];
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
  const settings = useMemo(() => readDenSettings(), []);
  const orgId = settings.activeOrgId?.trim() ?? "";
  const orgName = settings.activeOrgName?.trim() ?? "";
  const authToken = settings.authToken?.trim() ?? "";

  const [resources, setResources] = useState<OrgResources>({
    providers: [],
    marketplaces: [],
    workers: [],
    skills: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDefault, setSelectedDefault] = useState<{
    providerId: string;
    modelId: string;
    label: string;
  } | null>(null);

  // Redirect if no auth or no org — can't show onboarding without them
  useEffect(() => {
    if (!authToken || !orgId) {
      navigate("/session", { replace: true });
    }
  }, [authToken, navigate, orgId]);

  // Fetch all org resources in parallel
  useEffect(() => {
    if (!authToken || !orgId) return;
    let cancelled = false;

    const client = createDenClient({
      baseUrl: settings.baseUrl,
      apiBaseUrl: settings.apiBaseUrl,
      token: authToken,
    });

    void Promise.all([
      client.listOrgLlmProviders(orgId).catch(() => [] as DenOrgLlmProvider[]),
      client.listOrgMarketplaces(orgId).catch(() => [] as DenOrgMarketplace[]),
      client.listWorkers(orgId).catch(() => [] as DenWorkerSummary[]),
      fetchDenOrgSkillsCatalog(client, orgId).catch(() => [] as DenOrgSkillCard[]),
    ])
      .then(([providers, marketplaces, workers, skills]) => {
        if (cancelled) return;
        setResources({ providers, marketplaces, workers, skills });
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
  }, [authToken, orgId, settings.apiBaseUrl, settings.baseUrl]);

  const handleContinue = useCallback(() => {
    // If user picked a default model, write it
    if (selectedDefault) {
      writeStoredDefaultModel({
        providerID: selectedDefault.providerId,
        modelID: selectedDefault.modelId,
      });
    }
    navigate("/session", { replace: true });
  }, [navigate, selectedDefault]);

  const { providers, marketplaces, workers, skills } = resources;
  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);
  const hasResources = providers.length > 0 || marketplaces.length > 0 || workers.length > 0 || skills.length > 0;

  // Build summary counts
  const summaryParts: string[] = [];
  if (providers.length > 0) summaryParts.push(`${providers.length} AI provider${providers.length > 1 ? "s" : ""}`);
  if (marketplaces.length > 0) summaryParts.push(`${marketplaces.length} marketplace${marketplaces.length > 1 ? "s" : ""}`);
  if (workers.length > 0) summaryParts.push(`${workers.length} worker${workers.length > 1 ? "s" : ""}`);
  if (skills.length > 0) summaryParts.push(`${skills.length} skill${skills.length > 1 ? "s" : ""}`);

  return (
    <div className="relative min-h-screen bg-dls-background text-dls-text">
      {/* Background texture */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="absolute -left-[20%] -top-[30%] h-[70%] w-[60%] rounded-full bg-[radial-gradient(ellipse,rgba(14,51,217,0.06),transparent_70%)] blur-3xl" />
        <div className="absolute -bottom-[20%] -right-[10%] h-[50%] w-[50%] rounded-full bg-[radial-gradient(ellipse,rgba(255,126,46,0.05),transparent_70%)] blur-3xl" />
        <div className="absolute left-[30%] top-[60%] h-[40%] w-[40%] rounded-full bg-[radial-gradient(ellipse,rgba(255,227,64,0.04),transparent_70%)] blur-3xl" />
      </div>

      {/* Titlebar drag region */}
      <div className="absolute inset-x-0 top-0 z-20 h-10 mac:titlebar-drag" />

      <div className="relative z-10 flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-lg space-y-8">
          {/* Header */}
          <div className="space-y-3 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover">
              <Building2 size={28} className="text-dls-text" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-dls-text">
              {orgName || "Your organization"}
            </h1>
            {loading ? (
              <p className="text-sm text-dls-secondary">Loading available resources...</p>
            ) : error ? (
              <p className="text-sm text-red-11">{error}</p>
            ) : hasResources ? (
              <p className="text-sm text-dls-secondary">
                {summaryParts.join(", ")} available for your workspace.
              </p>
            ) : (
              <p className="text-sm text-dls-secondary">
                No resources are configured for this organization yet.
              </p>
            )}
          </div>

          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={24} className="animate-spin text-dls-secondary" />
            </div>
          ) : (
            <div className="space-y-6">
              {/* AI Providers */}
              {providers.length > 0 ? (
                <Section icon={<Cloud size={16} />} title="AI Providers" count={`${totalModels} model${totalModels === 1 ? "" : "s"}`}>
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
                <Section icon={<Puzzle size={16} />} title="Marketplaces" count={`${marketplaces.length}`}>
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
                <Section icon={<Server size={16} />} title="Cloud Workers" count={`${workers.length}`}>
                  {workers.map((worker) => (
                    <div key={worker.workerId} className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
                      <Server size={16} className="shrink-0 text-dls-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-dls-text">{worker.workerName}</div>
                        <div className="mt-0.5 text-xs text-dls-secondary">
                          {worker.status} {worker.provider ? `· ${worker.provider}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </Section>
              ) : null}

              {/* Skills */}
              {skills.length > 0 ? (
                <Section icon={<Sparkles size={16} />} title="Shared Skills" count={`${skills.length}`}>
                  <div className="flex flex-wrap gap-1.5">
                    {skills.slice(0, 8).map((skill) => (
                      <span
                        key={skill.id}
                        className="inline-flex items-center rounded-lg border border-dls-border bg-dls-surface px-2.5 py-1 text-xs text-dls-text"
                      >
                        {skill.title}
                      </span>
                    ))}
                    {skills.length > 8 ? (
                      <span className="inline-flex items-center px-2.5 py-1 text-xs text-dls-secondary">
                        +{skills.length - 8} more
                      </span>
                    ) : null}
                  </div>
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

          {/* Continue button */}
          <div className="flex justify-center pt-2">
            <button
              type="button"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-dls-accent px-8 text-sm font-semibold text-[var(--dls-accent-fg)] transition-all hover:bg-[var(--dls-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleContinue}
              disabled={loading}
            >
              {hasResources ? "Continue to workspace" : "Continue"}
              <ArrowRight size={16} />
            </button>
          </div>
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
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-dls-secondary">
        {icon}
        {title}
        <span className="text-dls-secondary/60">{count}</span>
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
          <div className="mt-0.5 text-xs text-dls-secondary">
            {provider.models.length === 1
              ? "1 model"
              : `${provider.models.length} models`}
          </div>
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
