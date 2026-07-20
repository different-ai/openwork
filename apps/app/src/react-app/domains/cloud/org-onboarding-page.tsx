/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRightIcon,
  Check,
  CheckCircle2,
  CircleAlert,
} from "lucide-react";
import {
  BuildingOffice2Icon,
  CloudIcon,
  Square3Stack3DIcon,
} from "@heroicons/react/24/solid";

import {
  createDenClient,
  readDenBootstrapConfig,
  readDenSettings,
  resolveDenBaseUrls,
  setDenBootstrapConfig,
  writeDenSettings,
  type DenDesktopConfig,
  type DenOrgLlmProvider,
  type DenOrgMarketplace,
  type DenOrgSummary,
} from "@/app/lib/den";
import { applyBrandAppName, applyBrandIcon, relaunchDesktopApp } from "@/app/lib/desktop";
import {
  isAlphaChannelAllowedByDesktopConfig,
  isAlphaUpdateAllowed,
  resolveFreshStableDesktopUpdate,
} from "@/app/lib/version-gate";
import { exchangeHandoffAndSignIn } from "@/app/lib/den-handoff";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { usePlatform } from "../../kernel/platform";
import { useBootState } from "../../shell/boot-state";
import { resolveModelDisplayName, resolveProviderDisplayName } from "@/app/utils";
import { ProviderIcon } from "../../design-system/provider-icon";
import { writeStoredDefaultModel } from "../../kernel/model-config";
import { orgOnboardingVisibilityEvent } from "../../shell/reload-coordinator";
import {
  Page,
  PageBackground,
  PageContainer,
  PageContent,
  PageDescription,
  PageFooter,
  PageHeader,
  PageLoading,
  PageLoadingDescription,
  PageLoadingSpinner,
  PageTitle,
  PageTitlebarRegion,
} from "@/components/page";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { Field, FieldLabel, FieldTitle } from "@/components/ui/field"
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group"
import { useOrgListWindow } from "./use-org-list-window";
import { useDesktopConfig } from "./desktop-config-provider";
import {
  hasWorkspaceBranding,
  workspaceBrandingFingerprint,
} from "./workspace-branding-restart";

const RELOAD_AFTER_ONBOARDING_KEY = "openwork.reloadAfterOrgOnboarding";
const APPLIED_BRANDING_FINGERPRINT_KEY = "openwork.den.appliedBrandingFingerprint";
const BRANDING_RESTART_RESUME_KEY = "openwork.den.brandingRestartResume";

type BrandingRestartState = {
  fingerprint: string;
  updateReady: boolean;
  warning: string | null;
};

type OnboardingUpdaterBridge = NonNullable<Window["__OPENWORK_ELECTRON__"]>["updater"];

declare global {
  interface Window {
    __openworkOnboardingUpdaterEvalBridge?: OnboardingUpdaterBridge;
  }
}

function onboardingUpdaterBridge(): OnboardingUpdaterBridge | undefined {
  if (import.meta.env.DEV && window.__openworkOnboardingUpdaterEvalBridge) {
    return window.__openworkOnboardingUpdaterEvalBridge;
  }
  return window.__OPENWORK_ELECTRON__?.updater;
}

async function stageOnboardingUpdate(
  desktopConfig: DenDesktopConfig,
): Promise<boolean> {
  const updater = onboardingUpdaterBridge();
  if (!updater?.getChannel || !updater.check || !updater.download) return false;

  const channelState = await updater.getChannel();
  if (
    channelState.channel === "alpha" &&
    !isAlphaChannelAllowedByDesktopConfig(desktopConfig)
  ) {
    await updater.setChannel?.("stable");
    return false;
  }
  let targetVersion: string | undefined;
  if (channelState.channel === "stable") {
    const selection = await resolveFreshStableDesktopUpdate({
      currentVersion: channelState.currentVersion,
      refreshDesktopConfig: async () => desktopConfig,
    });
    if (selection?.kind !== "update") return false;
    targetVersion = selection.targetVersion;
  }

  const update = await updater.check(channelState.channel, targetVersion);
  if (!update.available || update.reason) return false;
  if (
    channelState.channel === "alpha" &&
    update.latestVersion &&
    !(await isAlphaUpdateAllowed(update.latestVersion, desktopConfig))
  ) {
    return false;
  }

  const download = await updater.download();
  return download.ok;
}

function subscribeToDenSettings(onStoreChange: () => void) {
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => window.removeEventListener(denSettingsChangedEvent, onStoreChange);
}

function readDenSettingsSnapshot() {
  const settings = readDenSettings();
  return JSON.stringify({
    baseUrl: settings.baseUrl,
    authToken: settings.authToken ?? "",
    activeOrgId: settings.activeOrgId ?? "",
    activeOrgName: settings.activeOrgName ?? "",
  });
}

function useDenClient() {
  const settingsSnapshot = useSyncExternalStore(
    subscribeToDenSettings,
    readDenSettingsSnapshot,
    readDenSettingsSnapshot,
  );
  const settings = useMemo(() => readDenSettings(), [settingsSnapshot]);
  const authToken = settings.authToken ?? "";
  const denClient = useMemo(
    () =>
      createDenClient({
        baseUrl: settings.baseUrl,
        token: settings.authToken,
      }),
    [authToken, settings.baseUrl],
  );

  return {
    authToken,
    denClient,
    orgId: settings.activeOrgId ?? "",
    orgName: settings.activeOrgName ?? "",
    settings,
  };
}

/**
 * When an agent-first install prepared this desktop, read the non-secret
 * prepared summary so the onboarding payoff can greet the
 * user with "Setup complete" instead of a generic resource list.
 */
type PreparedBootstrapSummary = {
  orgName: string;
  claimLinks: Array<{ id: string; role: string; url: string; expiresAt: string }>;
};

function usePreparedBootstrap() {
  const bootstrap = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener(denSettingsChangedEvent, onStoreChange);
      return () => window.removeEventListener(denSettingsChangedEvent, onStoreChange);
    },
    readDenBootstrapConfig,
    readDenBootstrapConfig,
  );

  return useMemo<PreparedBootstrapSummary | null>(() => {
    if (!bootstrap.prepared?.skillTitle) return null;
    return {
      orgName: bootstrap.prepared.orgName || "Your workspace",
      claimLinks: bootstrap.claimLinks ?? [],
    };
  }, [bootstrap]);
}

function PreparedWorkspacePage({ prepared }: { prepared: PreparedBootstrapSummary }) {
  const platform = usePlatform();
  const ownerClaim = prepared.claimLinks.find((link) => link.role === "owner") ?? null;
  const [showSignInCode, setShowSignInCode] = useState(false);
  const [signInCode, setSignInCode] = useState("");
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  const submitSignInCode = useCallback(async () => {
    const grant = signInCode.trim();
    if (grant.length < 12 || signInBusy) {
      if (grant.length < 12) setSignInError("Paste a valid one-time sign-in code.");
      return;
    }

    const settings = readDenSettings();
    setSignInBusy(true);
    setSignInError(null);

    try {
      const result = await exchangeHandoffAndSignIn(grant, {
        baseUrl: settings.baseUrl,
        client: createDenClient({ baseUrl: settings.baseUrl }),
      });
      if (!result.ok) setSignInError(result.error);
    } finally {
      setSignInBusy(false);
    }
  }, [signInBusy, signInCode]);

  return (
    <Page>
      <PageBackground />
      <PageTitlebarRegion />
      <PageContainer>
        <PageHeader>
          <div
            data-openwork-prepared="true"
            data-openwork-provisional="true"
            className="mx-auto flex w-fit items-center gap-2 rounded-full border border-green-6/30 bg-green-2/30 px-3 py-1 text-xs font-semibold text-green-11"
          >
            <CheckCircle2 className="size-3.5" />
            Setup complete — OpenWork is ready
          </div>
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover">
            <BuildingOffice2Icon className="size-7 text-foreground" />
          </div>
          <PageTitle>{prepared.orgName}</PageTitle>
        </PageHeader>

        {ownerClaim ? (
          <PageContent>
            <div className="mx-auto grid w-full max-w-md gap-3">
              <Button
                type="button"
                onClick={() => platform.openLink(ownerClaim.url)}
                className="w-full sm:w-auto"
              >
                Claim workspace and continue
                <ArrowUpRightIcon data-icon="inline-end" />
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowSignInCode((visible) => !visible);
                  setSignInError(null);
                }}
              >
                {showSignInCode ? "Hide sign-in code" : "Paste sign-in code"}
              </Button>

              {showSignInCode ? (
                <div className="grid gap-3 rounded-2xl border border-dls-border bg-dls-surface p-4">
                  <Input
                    aria-label="One-time sign-in code"
                    value={signInCode}
                    onChange={(event) => setSignInCode(event.currentTarget.value)}
                    placeholder="Paste the code from your browser"
                    disabled={signInBusy}
                  />
                  <Button
                    type="button"
                    onClick={() => void submitSignInCode()}
                    disabled={signInBusy || !signInCode.trim()}
                  >
                    {signInBusy ? "Signing in..." : "Sign in to this workspace"}
                  </Button>
                </div>
              ) : null}

              {signInError ? (
                <Alert variant="destructive">
                  <CircleAlert />
                  <AlertDescription>{signInError}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </PageContent>
        ) : null}
      </PageContainer>
    </Page>
  );
}

function markProvidersSeen(providers: DenOrgLlmProvider[]) {
  if (providers.length === 0) return;

  try {
    const raw = window.localStorage.getItem("openwork.seenProviderIds");
    const existing: string[] = raw ? JSON.parse(raw) : [];
    const ids = new Set(existing);
    for (const provider of providers) ids.add(provider.id);
    window.localStorage.setItem("openwork.seenProviderIds", JSON.stringify([...ids]));
  } catch {}
}

/**
 * Full-screen onboarding page shown after sign-in + org selection.
 * Fetches all org resources (providers, marketplaces, skills)
 * and shows them so the user knows what their org provides.
 *
 * Route: /onboarding
 */
export function OrgOnboardingPage() {
  const navigate = useNavigate();
  const { authToken, denClient, orgId, settings } = useDenClient();
  const { markRouteReady } = useBootState();
  const prepared = usePreparedBootstrap();
  const [hasSelectedOrganization, setHasSelectedOrganization] = useState(false);
  
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(orgOnboardingVisibilityEvent, { detail: { visible: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent(orgOnboardingVisibilityEvent, { detail: { visible: false } }));
    };
  }, []);

  useEffect(() => {
    markRouteReady();
  }, [markRouteReady]);

  useEffect(() => {
    if (!authToken && !prepared) {
      navigate("/session", { replace: true });
    }
  }, [authToken, navigate, prepared]);

  useEffect(() => {
    if (authToken && orgId && prepared) {
      navigate("/session", { replace: true });
    }
  }, [authToken, navigate, orgId, prepared]);

  useEffect(() => {
    if (!authToken || !orgId) return;
    if (window.localStorage.getItem(BRANDING_RESTART_RESUME_KEY) !== orgId) return;
    window.localStorage.removeItem(BRANDING_RESTART_RESUME_KEY);
    navigate("/session", { replace: true });
  }, [authToken, navigate, orgId]);

  const { data, error, isPending } = useQuery({
    queryKey: ["den-org-onboarding", settings.baseUrl, "orgs"],
    enabled: Boolean(authToken),
    queryFn: () => denClient.listOrgs(),
  });

  if (!authToken) {
    return prepared ? <PreparedWorkspacePage prepared={prepared} /> : null;
  }

  if (isPending) {
    return (
      <Page>
        <PageBackground />
        <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover">
              <BuildingOffice2Icon className="size-7 text-foreground" />
            </div>
            <PageTitle>Your organization</PageTitle>
          </PageHeader>
          <PageContent>
            <PageLoading>
              <PageLoadingSpinner />
              <PageLoadingDescription>Loading organizations...</PageLoadingDescription>
            </PageLoading>
          </PageContent>
        </PageContainer>
      </Page>
    );
  }

  if (error) {
    return (
      <Page>
        <PageBackground />
        <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover">
              <BuildingOffice2Icon className="size-7 text-foreground" />
            </div>
            <PageTitle>Choose your organization</PageTitle>
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>
                {error instanceof Error ? error.message : "Unable to load organizations."}
              </AlertDescription>
            </Alert>
          </PageHeader>
        </PageContainer>
      </Page>
    );
  }

  if ((data?.orgs.length ?? 0) > 0 && !hasSelectedOrganization) {
    return (
      <OrganizationSelectionPage
        orgs={data.orgs}
        defaultOrganization={
          data.orgs.find((org) => org.id === orgId) ??
          data.orgs[0]
        }
        onContinue={() => setHasSelectedOrganization(true)}
      />
    );
  }

  return <ResourceSelectionPage />;
}

export function ResourceSelectionPage() {
  const navigate = useNavigate();
  const platform = usePlatform();
  const { markRouteReady } = useBootState();
  const { authToken, denClient, orgId, orgName, settings } = useDenClient();
  const { refreshFresh } = useDesktopConfig();

  const prepared = usePreparedBootstrap();

  const [selectedDefault, setSelectedDefault] = useState<{
    providerId: string;
    modelId: string;
    label: string;
  } | null>(null);
  const [preparingBranding, setPreparingBranding] = useState(false);
  const [brandingRestart, setBrandingRestart] = useState<BrandingRestartState | null>(null);

  // Redirect if no auth or no org — can't show onboarding without them
  useEffect(() => {
    markRouteReady();
  }, [markRouteReady]);

  useEffect(() => {
    if (!authToken || !orgId) {
      navigate("/session", { replace: true });
    }
  }, [authToken, navigate, orgId]);

  const { providers, marketplaces, loading, error } = useQueries({
    queries: [
      {
        queryKey: ["den-org-onboarding", settings.baseUrl, orgId, "providers"],
        enabled: Boolean(authToken && orgId),
        queryFn: () => denClient.listOrgLlmProviders(orgId),
      },
      {
        queryKey: ["den-org-onboarding", settings.baseUrl, orgId, "marketplaces"],
        enabled: Boolean(authToken && orgId),
        queryFn: () => denClient.listOrgMarketplaces(orgId),
      },
    ],
    combine: ([providersQuery, marketplacesQuery]) => ({
      providers: providersQuery.data ?? [],
      marketplaces: marketplacesQuery.data ?? [],
      loading: providersQuery.isPending || marketplacesQuery.isPending,
      error: providersQuery.error?.message ?? marketplacesQuery.error?.message ?? null,
    }),
  });

  const finishOnboarding = useCallback(() => {
    // If user picked a default model, write it
    if (selectedDefault) {
      writeStoredDefaultModel({
        providerID: selectedDefault.providerId,
        modelID: selectedDefault.modelId,
      });
    }
    // Mark all providers shown on this page as "seen" so the global
    // toast doesn't re-fire for them on the next sync interval.
    markProvidersSeen(providers);
    if (providers.length > 0) {
      try {
        window.localStorage.setItem(RELOAD_AFTER_ONBOARDING_KEY, "1");
      } catch {}
    }
    navigate("/session", { replace: true });
  }, [navigate, providers, selectedDefault]);

  const handleContinue = useCallback(async () => {
    if (!window.__OPENWORK_ELECTRON__?.shell?.relaunch) {
      finishOnboarding();
      return;
    }

    setPreparingBranding(true);
    try {
      const desktopConfig = await refreshFresh();
      if (!hasWorkspaceBranding(desktopConfig)) {
        finishOnboarding();
        return;
      }

      const fingerprint = workspaceBrandingFingerprint(orgId, desktopConfig);
      if (window.localStorage.getItem(APPLIED_BRANDING_FINGERPRINT_KEY) === fingerprint) {
        finishOnboarding();
        return;
      }

      const bootstrap = readDenBootstrapConfig();
      await setDenBootstrapConfig({
        ...bootstrap,
        brandAppName: desktopConfig.brandAppName ?? null,
        brandLogoUrl: desktopConfig.brandLogoUrl ?? null,
        brandIconUrl: desktopConfig.brandIconUrl ?? null,
      });
      const [, iconResult] = await Promise.all([
        applyBrandAppName(desktopConfig.brandAppName ?? null),
        applyBrandIcon(desktopConfig.brandIconUrl ?? null),
      ]);

      let updateReady = false;
      let warning = desktopConfig.brandIconUrl && !iconResult.ok
        ? "The workspace app icon could not be prepared."
        : null;
      try {
        updateReady = await stageOnboardingUpdate(desktopConfig);
      } catch (error) {
        warning ??= error instanceof Error ? error.message : "The application update could not be prepared.";
      }
      setBrandingRestart({ fingerprint, updateReady, warning });
    } catch (error) {
      setBrandingRestart({
        fingerprint: workspaceBrandingFingerprint(orgId, {}),
        updateReady: false,
        warning: error instanceof Error ? error.message : "Workspace branding could not be prepared.",
      });
    } finally {
      setPreparingBranding(false);
    }
  }, [finishOnboarding, orgId, refreshFresh]);

  const restartWithBranding = useCallback(async () => {
    if (!brandingRestart) return;
    window.localStorage.setItem(APPLIED_BRANDING_FINGERPRINT_KEY, brandingRestart.fingerprint);
    window.localStorage.setItem(BRANDING_RESTART_RESUME_KEY, orgId);
    if (brandingRestart.updateReady) {
      const result = await onboardingUpdaterBridge()?.installAndRestart?.();
      if (result?.ok) return;
    }
    await relaunchDesktopApp();
  }, [brandingRestart, orgId]);

  const continueWithoutRestart = useCallback(() => {
    if (brandingRestart) {
      window.localStorage.setItem(APPLIED_BRANDING_FINGERPRINT_KEY, brandingRestart.fingerprint);
    }
    finishOnboarding();
  }, [brandingRestart, finishOnboarding]);

  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  const hasResources = providers.length > 0 || marketplaces.length > 0;

  if (preparingBranding) {
    return (
      <Page>
        <PageBackground />
        <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover">
              <BuildingOffice2Icon className="size-7 text-foreground" />
            </div>
            <PageTitle>Preparing workspace identity</PageTitle>
            <PageDescription>
              Applying {orgName || "your workspace"}&apos;s branding and checking for an application update.
            </PageDescription>
          </PageHeader>
          <PageContent>
            <PageLoading>
              <PageLoadingSpinner />
              <PageLoadingDescription>Preparing workspace...</PageLoadingDescription>
            </PageLoading>
          </PageContent>
        </PageContainer>
      </Page>
    );
  }

  if (brandingRestart) {
    return (
      <Page>
        <PageBackground />
        <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover">
              <BuildingOffice2Icon className="size-7 text-foreground" />
            </div>
            <PageTitle>Workspace identity is ready</PageTitle>
            <PageDescription>
              Restart OpenWork once to finish applying {orgName || "your workspace"}&apos;s name and app icon everywhere.
            </PageDescription>
            {brandingRestart.updateReady ? (
              <div className="mx-auto flex w-fit items-center gap-2 rounded-full border border-green-6/30 bg-green-2/30 px-3 py-1 text-xs font-semibold text-green-11">
                <CheckCircle2 className="size-3.5" />
                Application update downloaded
              </div>
            ) : null}
            {brandingRestart.warning ? (
              <Alert>
                <CircleAlert />
                <AlertDescription>
                  {brandingRestart.warning} You can still continue to the workspace.
                </AlertDescription>
              </Alert>
            ) : null}
          </PageHeader>
          <PageContent>
            <details className="mx-auto w-full max-w-md rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-sm">
              <summary className="cursor-pointer font-medium">Why restart?</summary>
              <p className="mt-2 text-muted-foreground">
                Restarting refreshes the workspace name and icon across your operating system and installs the prepared application update.
              </p>
            </details>
          </PageContent>
          <PageFooter>
            <Button type="button" variant="outline" onClick={continueWithoutRestart}>
              Continue without restarting
            </Button>
            <Button type="button" size="lg" onClick={() => void restartWithBranding()}>
              Restart OpenWork
              <ArrowRight data-icon="inline-end" />
            </Button>
          </PageFooter>
        </PageContainer>
      </Page>
    );
  }

  return (
    <Page>
      <PageBackground />
      <PageTitlebarRegion />

      <PageContainer>
        {/* Header */}
        <PageHeader>
          {prepared ? (
            <div
              data-openwork-prepared="true"
              className="mx-auto flex w-fit items-center gap-2 rounded-full border border-green-6/30 bg-green-2/30 px-3 py-1 text-xs font-semibold text-green-11"
            >
              <CheckCircle2 className="size-3.5" />
              Setup complete — OpenWork prepared this workspace
            </div>
          ) : null}
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover">
            <BuildingOffice2Icon className="size-7 text-foreground" />
          </div>
          <PageTitle>
            {orgName || "Your organization"}
          </PageTitle>
          {loading ? (
            null
          ) : error ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : hasResources ? (
            <PageDescription>
              You have access to the following resources.
            </PageDescription>
          ) : null}
        </PageHeader>

        {loading ? (
          <PageContent>
            <PageLoading>
              <PageLoadingSpinner />
              <PageLoadingDescription>Loading available resources...</PageLoadingDescription>
            </PageLoading>
          </PageContent>
        ) : !hasResources ? (
          <PageContent>
            <Empty className="h-fit flex-none">
              <EmptyHeader>
                <EmptyTitle>No resources have been configured for this organization yet.</EmptyTitle>
                <EmptyDescription>
                  Add AI providers or marketplaces from the OpenWork Cloud dashboard.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="outline"
                  onClick={() => platform.openLink(resolveDenBaseUrls(settings.baseUrl).baseUrl)}
                >
                  Open OpenWork Cloud
                  <ArrowUpRightIcon data-icon="inline-end" />
                </Button>
              </EmptyContent>
            </Empty>
          </PageContent>
        ) : (
          <PageContent>
            <ScrollArea className="px-2.5">
              <ScrollAreaViewport>
                <Accordion
                  multiple
                  className="rounded-2xl border border-border bg-transparent shadow-none before:hidden"
                >
                  {/* AI Providers */}
                  {providers.length > 0 ? (
                    <Section
                      icon={<CloudIcon className="size-5 text-foreground/60" />}
                      title="AI Providers"
                      description="Models you can use in your workspace."
                      count={`${totalModels} model${totalModels === 1 ? "" : "s"}`}
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
                      icon={<Square3Stack3DIcon className="size-5 text-foreground/60" />}
                      title="Marketplaces"
                      description="App stores with extensions and plugins for your workspace."
                      count={`${marketplaces.length} marketplace${marketplaces.length === 1 ? "" : "s"}`}
                    >
                      {marketplaces.map((mp) => (
                        <MarketplaceCard key={mp.id} marketplace={mp} />
                      ))}
                    </Section>
                  ) : null}

                </Accordion>
              </ScrollAreaViewport>
            </ScrollArea>
            {/* Selected default indicator */}
            {selectedDefault ? (
              <div className="rounded-xl border border-green-6/30 bg-green-2/30 px-4 py-3 text-center text-sm text-green-11">
                <Check size={14} className="mr-1 inline" />
                {selectedDefault.label} will be set as your default model.
              </div>
            ) : null}
          </PageContent>
        )}

        <PageFooter>
          {/* Footer hint */}
          {!loading && hasResources ? (
            <p className="text-center text-xs text-muted-foreground text-balance leading-relaxed tracking-wide">
              Providers are added to your workspace automatically. Marketplaces are available from Cloud settings.
            </p>
          ) : null}
          <Button
            className="w-fit"
            type="button"
            size="lg"
            onClick={() => void handleContinue()}
            disabled={loading || preparingBranding}
          >
            {preparingBranding
              ? "Preparing workspace..."
              : hasResources
                ? "Continue to workspace"
                : "Continue"}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </PageFooter>
      </PageContainer>
    </Page>
  );
}

interface MarketplaceCardProps {
  marketplace: DenOrgMarketplace;
}

function MarketplaceCard({ marketplace }: MarketplaceCardProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3 py-3 -mx-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{marketplace.name}</div>
        {marketplace.description ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {marketplace.description}
          </div>
        ) : null}
      </div>
        <span className="shrink-0 text-xs text-muted-foreground">
        {marketplace.pluginCount} plugin{marketplace.pluginCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

interface SectionProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  count: string;
  children: React.ReactNode;
}

function Section({ icon, title, description, count, children }: SectionProps) {
  return (
    <AccordionItem value={title}>
      <AccordionTrigger className="items-center px-5 py-4 gap-4.75 hover:no-underline">
        {icon}

        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <h3 className="flex items-center gap-2 font-medium tracking-wide">
            {title}
            <span className="text-muted-foreground text-xs uppercase">{count}</span>
          </h3>
          <p className="text-sm font-normal normal-case tracking-normal text-muted-foreground">
            {description}
          </p>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-2 pb-2">
        {children}
      </AccordionContent>
    </AccordionItem>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider card with "Use as default" option                         */
/* ------------------------------------------------------------------ */

interface ProviderCardProps {
  provider: DenOrgLlmProvider;
  selectedDefault: { providerId: string; modelId: string } | null;
  onSelectDefault: (value: {
    providerId: string;
    modelId: string;
    label: string;
  } | null) => void;
}

function ProviderCard({ provider, selectedDefault, onSelectDefault }: ProviderCardProps) {
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
      className={cn(
        "rounded-xl border px-3 py-3 transition-colors -mx-2",
        isSelected ? "border-green-6" : "border-border",
      )}
    >
      <div className="flex items-center gap-4.5">
        <ProviderIcon
          providerId={provider.providerId}
          providerName={provider.name}
          size={20}
          className="text-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {resolveProviderDisplayName(provider.name || provider.providerId)}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {provider.models.length === 1
              ? "1 model"
              : `${provider.models.length} models`}
          </div>
        </div>
        {firstModel ? (
          <button
            type="button"
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
              isSelected
                ? "bg-green-3 text-green-11"
                : "border border-border text-muted-foreground hover:bg-hover hover:text-foreground",
            )}
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
              className="inline-flex items-center rounded-md border border-border bg-hover px-2 py-0.5 font-mono text-xs text-muted-foreground"
            >
              {model.name || resolveModelDisplayName(model.id)}
            </span>
          ))}
          {provider.models.length > 5 ? (
            <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs text-muted-foreground">
              +{provider.models.length - 5} more
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface OrganizationSelectionPageProps {
  orgs: DenOrgSummary[];
  defaultOrganization: DenOrgSummary;
  onContinue: () => void;
}

function OrganizationSelectionPage({
  orgs,
  defaultOrganization,
  onContinue,
}: OrganizationSelectionPageProps) {
  const { authToken, denClient, settings } = useDenClient();
  const [selected, setSelected] = useState(defaultOrganization);
  const { error, isPending, mutate } = useMutation({
    mutationFn: async (nextOrg: DenOrgSummary) => {
      await denClient.setActiveOrganization({ organizationId: nextOrg.id });
      return nextOrg;
    },
    onSuccess: (nextOrg) => {
      writeDenSettings({
        ...settings,
        authToken: authToken || null,
        activeOrgId: nextOrg.id,
        activeOrgSlug: nextOrg.slug,
        activeOrgName: nextOrg.name,
      });

      onContinue();
    },
  });

  return (
    <Page>
      <PageBackground />
      <PageTitlebarRegion />
      <PageContainer>
        <PageHeader>
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-dls-border bg-dls-hover">
            <BuildingOffice2Icon className="size-7 text-foreground" />
          </div>
          <PageTitle>Choose your organization</PageTitle>
          {error ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>
                {error instanceof Error ? error.message : "Unable to select organization."}
              </AlertDescription>
            </Alert>
          ) : (
            <PageDescription>
              Select the organization whose cloud resources should be connected to this workspace.
            </PageDescription>
          )}
        </PageHeader>

        <PageContent>
          <OrganizationList
            orgs={orgs}
            value={selected}
            onValueChange={setSelected}
          />
        </PageContent>

        <PageFooter>
          <Button
            className="w-fit"
            type="button"
            size="lg"
            onClick={() => mutate(selected)}
            disabled={isPending}
          >
            {isPending ? "Connecting..." : "Continue with organization"}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </PageFooter>
      </PageContainer>
    </Page>
  );
}

interface OrganizationListProps {
  orgs: DenOrgSummary[];
  value: DenOrgSummary;
  onValueChange: (value: DenOrgSummary) => void;
}

export function OrganizationList({ orgs, value, onValueChange }: OrganizationListProps) {
  const { filtered, query, showMore, updateQuery, visible } = useOrgListWindow(orgs);
  const hasMore = visible.length < filtered.length;

  return (
    <div className="flex flex-col gap-3">
      {orgs.length > 10 ? (
        <Input
          aria-label="Search organizations"
          placeholder="Search organizations..."
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
        />
      ) : null}

      <RadioGroup
        value={value.id}
        onValueChange={(nextOrgId) => {
          const nextOrg = orgs.find((org) => org.id === nextOrgId);
          if (nextOrg) onValueChange(nextOrg);
        }}
        aria-label="Organizations"
      >
        {visible.map((org) => {
          const fieldId = `organization-${org.id}`;

          return (
            <FieldLabel
              key={org.id}
              htmlFor={fieldId}
              className="p-0! transition-colors hover:bg-input/10"
            >
              <Field orientation="horizontal">
                <FieldTitle className="flex min-w-0 items-center gap-4">
                  <BuildingOffice2Icon className="size-6 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-col items-start">
                    <span className="max-w-full truncate text-sm font-semibold">
                      {org.name}
                    </span>
                    <span className="max-w-full truncate text-muted-foreground text-xs">
                      {org.slug}
                    </span>
                  </div>
                </FieldTitle>
                <RadioGroupItem
                  value={org.id}
                  id={fieldId}
                  className="group-hover/field-label:bg-foreground/25"
                />
              </Field>
            </FieldLabel>
          );
        })}
      </RadioGroup>

      {filtered.length === 0 && query.trim() ? (
        <div className="text-sm text-muted-foreground">
          No organizations match your search.
        </div>
      ) : null}

      {hasMore ? (
        <div className="flex flex-col items-start gap-2">
          <Button type="button" variant="outline" size="sm" onClick={showMore}>
            Show more
          </Button>
          <div className="text-xs text-muted-foreground">
            Showing {visible.length} of {filtered.length} organizations
          </div>
        </div>
      ) : null}
    </div>
  )
}
