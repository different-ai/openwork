/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Building2, Check, Loader2, Zap } from "lucide-react";

import {
  createDenClient,
  readDenSettings,
  type DenOrgLlmProvider,
} from "../../../app/lib/den";
import { resolveModelDisplayName, resolveProviderDisplayName } from "../../../app/utils";
import { ProviderIcon } from "../../design-system/provider-icon";

const STORAGE_KEY = "openwork.orgOnboardingSeen";

function markOnboardingSeen(orgId: string): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const existing: string[] = raw ? JSON.parse(raw) : [];
    if (!existing.includes(orgId)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...existing, orgId]));
    }
  } catch {}
}

export function hasSeenOnboarding(orgId: string): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list: string[] = raw ? JSON.parse(raw) : [];
    return list.includes(orgId);
  } catch {
    return false;
  }
}

/**
 * Full-screen onboarding page shown after sign-in + org selection.
 *
 * Fetches the org's cloud providers from Den and shows them to the user
 * so they know what's available. The cloud provider sync in the provider
 * auth store runs in the background, so by the time the user clicks
 * "Continue" the providers should already be imported into the workspace.
 *
 * Route: /onboarding
 */
export function OrgOnboardingPage() {
  const navigate = useNavigate();
  const settings = useMemo(() => readDenSettings(), []);
  const orgId = settings.activeOrgId?.trim() ?? "";
  const orgName = settings.activeOrgName?.trim() ?? "";
  const authToken = settings.authToken?.trim() ?? "";

  const [providers, setProviders] = useState<DenOrgLlmProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Redirect if no auth or no org
  useEffect(() => {
    if (!authToken || !orgId) {
      navigate("/session", { replace: true });
    }
  }, [authToken, navigate, orgId]);

  // Already seen? Skip to session.
  useEffect(() => {
    if (orgId && hasSeenOnboarding(orgId)) {
      navigate("/session", { replace: true });
    }
  }, [navigate, orgId]);

  // Fetch org providers from Den
  useEffect(() => {
    if (!authToken || !orgId) return;
    let cancelled = false;

    const client = createDenClient({
      baseUrl: settings.baseUrl,
      apiBaseUrl: settings.apiBaseUrl,
      token: authToken,
    });

    void client
      .listOrgLlmProviders(orgId)
      .then((result) => {
        if (!cancelled) setProviders(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load providers");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [authToken, orgId, settings.apiBaseUrl, settings.baseUrl]);

  const handleContinue = useCallback(() => {
    if (orgId) markOnboardingSeen(orgId);
    navigate("/session", { replace: true });
  }, [navigate, orgId]);

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);

  return (
    <div className="relative min-h-screen bg-dls-background text-dls-text">
      {/* Background texture (matching sign-in page) */}
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
            ) : providers.length > 0 ? (
              <p className="text-sm text-dls-secondary">
                {providers.length === 1
                  ? `1 AI provider with ${totalModels} model${totalModels === 1 ? "" : "s"}`
                  : `${providers.length} AI providers with ${totalModels} model${totalModels === 1 ? "" : "s"}`}{" "}
                available for your workspace.
              </p>
            ) : (
              <p className="text-sm text-dls-secondary">
                No AI providers are configured for this organization yet.
              </p>
            )}
          </div>

          {/* Provider list */}
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={24} className="animate-spin text-dls-secondary" />
            </div>
          ) : providers.length > 0 ? (
            <div className="space-y-3">
              {providers.map((provider) => (
                <ProviderCard key={provider.id} provider={provider} />
              ))}
            </div>
          ) : null}

          {/* Footer hint */}
          {!loading && providers.length > 0 ? (
            <p className="text-center text-xs text-dls-secondary">
              These providers are being added to your workspace automatically.
            </p>
          ) : null}

          {/* Continue button */}
          <div className="flex justify-center pt-2">
            <button
              type="button"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-dls-accent px-8 text-sm font-semibold text-[var(--dls-accent-fg)] transition-all hover:bg-[var(--dls-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleContinue}
              disabled={loading}
            >
              {providers.length > 0 ? "Continue to workspace" : "Continue"}
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider card                                                      */
/* ------------------------------------------------------------------ */

function ProviderCard({ provider }: { provider: DenOrgLlmProvider }) {
  return (
    <div className="rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
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
        <Check size={16} className="shrink-0 text-green-11" />
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
