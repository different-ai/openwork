/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  ArrowRight,
  ArrowUpRightIcon,
  CheckCircle2,
  CircleAlert,
} from "lucide-react";
import {
  BuildingOffice2Icon,
} from "@heroicons/react/24/solid";

import {
  createDenClient,
  readDenBootstrapConfig,
  readDenSettings,
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
import {
  DEN_HANDOFF_AUTO_CONTINUE_KEY,
  exchangeHandoffAndSignIn,
} from "@/app/lib/den-handoff";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { clearOrgSelectionPending, readOrgSelectionPending } from "@/app/lib/den-sign-in-intent";
import { usePlatform } from "../../kernel/platform";
import { useBootState } from "../../shell/boot-state";
import { resolveModelDisplayName, resolveProviderDisplayName } from "@/app/utils";
import { ProviderIcon } from "../../design-system/provider-icon";
import { writeStoredDefaultModel } from "../../kernel/model-config";
import { orgOnboardingVisibilityEvent } from "../../shell/reload-coordinator";
import {
  Page,
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { OnboardingIntro, OnboardingResourceRow } from "@openwork/ui/react";
import { listAssignedConnectCapabilities } from "../session/surface/connect-capability-inventory";
import { resolveOrgMcpConnectionCardState } from "../connections/use-org-mcp-connections";
import { connectionNeedsReconnect } from "../connections/native-provider-connections";
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
    !(await isAlphaUpdateAllowed(
      update.latestVersion,
      desktopConfig,
      channelState.currentVersion,
    ))
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
        // A pasted one-time code is a desktop-initiated sign-in.
        desktopInitiated: true,
      });
      if (!result.ok) setSignInError(result.error);
    } finally {
      setSignInBusy(false);
    }
  }, [signInBusy, signInCode]);

  return (
    <Page>
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

type OrgOnboardingInitialSelectionState = {
  hasSelectedOrganization: boolean;
  autoContinueResources: boolean;
};

export function initialOrgOnboardingSelectionState(): OrgOnboardingInitialSelectionState {
  return {
    hasSelectedOrganization: false,
    autoContinueResources: false,
  };
}

type OrgOnboardingPostListStep =
  | { kind: "auto-select-single-org"; organization: DenOrgSummary }
  | { kind: "choose-org"; defaultOrganization: DenOrgSummary }
  | { kind: "resources"; autoContinue: boolean };

export function resolveOrgOnboardingPostListStep({
  orgs,
  activeOrgId,
  hasSelectedOrganization,
  autoContinueResources,
  autoSelectFailedOrgId,
}: {
  orgs: DenOrgSummary[];
  activeOrgId: string;
  hasSelectedOrganization: boolean;
  autoContinueResources: boolean;
  autoSelectFailedOrgId: string | null;
}): OrgOnboardingPostListStep {
  const singleOrg = orgs.length === 1 ? orgs[0] : null;

  if (orgs.length > 0 && !hasSelectedOrganization) {
    if (singleOrg && autoSelectFailedOrgId !== singleOrg.id) {
      return { kind: "auto-select-single-org", organization: singleOrg };
    }

    return {
      kind: "choose-org",
      defaultOrganization: orgs.find((org) => org.id === activeOrgId) ?? orgs[0],
    };
  }

  return {
    kind: "resources",
    autoContinue: autoContinueResources,
  };
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
  const initialSelectionState = initialOrgOnboardingSelectionState();
  const [hasSelectedOrganization, setHasSelectedOrganization] = useState(
    initialSelectionState.hasSelectedOrganization,
  );
  const [autoContinueResources, setAutoContinueResources] = useState(
    initialSelectionState.autoContinueResources,
  );
  const [autoSelectFailedOrgId, setAutoSelectFailedOrgId] = useState<string | null>(null);
  const autoSelectingOrgIdRef = useRef<string | null>(null);
  // A desktop-initiated sign-in parks the exchange-reported org here instead
  // of committing it; the chooser pre-highlights it as its default.
  const [suggestedOrgId] = useState(() => readOrgSelectionPending().suggestion?.id ?? "");

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
  const orgs = data?.orgs ?? [];
  const postListStep = resolveOrgOnboardingPostListStep({
    orgs,
    activeOrgId: orgId || suggestedOrgId,
    hasSelectedOrganization,
    autoContinueResources,
    autoSelectFailedOrgId,
  });
  const autoSelectOrg = postListStep.kind === "auto-select-single-org"
    ? postListStep.organization
    : null;

  useEffect(() => {
    if (!authToken || !autoSelectOrg) return;
    if (autoSelectingOrgIdRef.current === autoSelectOrg.id) return;

    let cancelled = false;
    autoSelectingOrgIdRef.current = autoSelectOrg.id;
    void denClient
      .setActiveOrganization({ organizationId: autoSelectOrg.id })
      .then(() => {
        if (cancelled) return;
        clearOrgSelectionPending();
        writeDenSettings({
          ...settings,
          authToken: authToken || null,
          activeOrgId: autoSelectOrg.id,
          activeOrgSlug: autoSelectOrg.slug,
          activeOrgName: autoSelectOrg.name,
        });
        setAutoContinueResources(false);
        setHasSelectedOrganization(true);
      })
      .catch(() => {
        if (!cancelled) setAutoSelectFailedOrgId(autoSelectOrg.id);
      })
      .finally(() => {
        if (autoSelectingOrgIdRef.current === autoSelectOrg.id) {
          autoSelectingOrgIdRef.current = null;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, autoSelectOrg, denClient, settings]);

  if (!authToken) {
    return prepared ? <PreparedWorkspacePage prepared={prepared} /> : null;
  }

  if (isPending) {
    return (
      <Page>
          <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
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
          <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
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

  if (postListStep.kind === "auto-select-single-org") {
    return (
      <Page>
          <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
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

  if (postListStep.kind === "choose-org") {
    return (
      <OrganizationSelectionPage
        orgs={orgs}
        defaultOrganization={postListStep.defaultOrganization}
        onContinue={() => {
          setAutoContinueResources(false);
          setHasSelectedOrganization(true);
        }}
      />
    );
  }

  return (
    <ResourceSelectionPage
      autoContinue={postListStep.autoContinue}
    />
  );
}

export function ResourceSelectionPage({ autoContinue = false }: { autoContinue?: boolean }) {
  const navigate = useNavigate();
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
  const autoContinueAttemptedRef = useRef(false);

  // Redirect if no auth or no org — can't show onboarding without them
  useEffect(() => {
    markRouteReady();
  }, [markRouteReady]);

  useEffect(() => {
    if (!authToken || !orgId) {
      navigate("/session", { replace: true });
    }
  }, [authToken, navigate, orgId]);

  const { providers, marketplaces, capabilities, connections, loading, error } = useQueries({
    queries: [
      {
        queryKey: ["den-org-onboarding", settings.baseUrl, authToken, orgId, "providers"],
        enabled: Boolean(authToken && orgId),
        queryFn: () => denClient.listOrgLlmProviders(orgId),
      },
      {
        queryKey: ["den-org-onboarding", settings.baseUrl, authToken, orgId, "marketplaces"],
        enabled: Boolean(authToken && orgId),
        queryFn: () => denClient.listOrgMarketplaces(orgId),
      },
      {
        queryKey: ["den-org-onboarding", settings.baseUrl, authToken, orgId, "capabilities"],
        enabled: Boolean(authToken && orgId),
        queryFn: () => listAssignedConnectCapabilities({ client: denClient, organizationId: orgId }),
      },
      {
        queryKey: ["den-org-onboarding", settings.baseUrl, authToken, orgId, "connections"],
        enabled: Boolean(authToken && orgId),
        queryFn: () => denClient.listMcpConnections(orgId, "usable"),
      },
    ],
    combine: ([providersQuery, marketplacesQuery, capabilitiesQuery, connectionsQuery]) => ({
      providers: providersQuery.data ?? [],
      marketplaces: marketplacesQuery.data ?? [],
      capabilities: capabilitiesQuery.data,
      connections: connectionsQuery.data ?? [],
      loading: providersQuery.isPending || marketplacesQuery.isPending || capabilitiesQuery.isPending || connectionsQuery.isPending,
      error: providersQuery.error?.message ?? marketplacesQuery.error?.message ?? capabilitiesQuery.error?.message ?? connectionsQuery.error?.message ?? null,
    }),
  });

  const finishOnboarding = useCallback((optionsArg?: { requestReload?: boolean }) => {
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
    try {
      window.sessionStorage.removeItem(DEN_HANDOFF_AUTO_CONTINUE_KEY);
    } catch {}
    if (providers.length > 0 && optionsArg?.requestReload !== false) {
      try {
        window.localStorage.setItem(RELOAD_AFTER_ONBOARDING_KEY, "1");
      } catch {}
    }
    navigate("/session", { replace: true });
  }, [navigate, providers, selectedDefault]);

  const handleContinue = useCallback(async (optionsArg?: { requestReload?: boolean }) => {
    if (!window.__OPENWORK_ELECTRON__?.shell?.relaunch) {
      finishOnboarding({ requestReload: optionsArg?.requestReload });
      return;
    }

    setPreparingBranding(true);
    try {
      const desktopConfig = await refreshFresh();
      if (!hasWorkspaceBranding(desktopConfig)) {
        finishOnboarding({ requestReload: optionsArg?.requestReload });
        return;
      }

      const fingerprint = workspaceBrandingFingerprint(orgId, desktopConfig);
      if (window.localStorage.getItem(APPLIED_BRANDING_FINGERPRINT_KEY) === fingerprint) {
        finishOnboarding({ requestReload: optionsArg?.requestReload });
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

  useEffect(() => {
    if (!autoContinue || autoContinueAttemptedRef.current) return;
    if (loading || error || preparingBranding || brandingRestart) return;

    autoContinueAttemptedRef.current = true;
    void handleContinue({ requestReload: false });
  }, [autoContinue, brandingRestart, error, handleContinue, loading, preparingBranding]);

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
  const hasResources = providers.length > 0 || marketplaces.length > 0 || Boolean(capabilities?.skills.length) || connections.length > 0;
  const autoContinuePending =
    autoContinue && !loading && !error && !brandingRestart;

  if (preparingBranding) {
    return (
      <Page>
          <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
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
          <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
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

  if (autoContinuePending) {
    return (
      <Page>
          <PageTitlebarRegion />
        <PageContainer>
          <PageHeader>
            <PageTitle>{orgName || "Your organization"}</PageTitle>
          </PageHeader>
          <PageContent>
            <PageLoading>
              <PageLoadingSpinner />
              <PageLoadingDescription>Loading available resources...</PageLoadingDescription>
            </PageLoading>
          </PageContent>
        </PageContainer>
      </Page>
    );
  }

  return (
    <Page className="overflow-y-auto">
      <PageTitlebarRegion />

      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-14 sm:py-20">
        {/* Header */}
        <PageHeader className="text-left">
          {prepared ? (
            <div
              data-openwork-prepared="true"
              className="mx-auto flex w-fit items-center gap-2 rounded-full border border-green-6/30 bg-green-2/30 px-3 py-1 text-xs font-semibold text-green-11"
            >
              <CheckCircle2 className="size-3.5" />
              Setup complete — OpenWork prepared this workspace
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">{orgName || "Your organization"}</p>
          <OnboardingIntro title="Your team workspace" />
          {loading ? (
            null
          ) : error ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </PageHeader>

        {loading ? (
          <PageContent className="grow-0 overflow-visible">
            <PageLoading>
              <PageLoadingSpinner />
              <PageLoadingDescription>Loading available resources...</PageLoadingDescription>
            </PageLoading>
          </PageContent>
        ) : !hasResources ? (
          <PageContent className="grow-0 overflow-visible">
            <Empty className="h-fit flex-none">
              <EmptyHeader>
                <EmptyTitle>{error ? "Your shared resources could not be loaded." : "Your team has not shared resources with you yet."}</EmptyTitle>
                <EmptyDescription>
                  {error ? "Continue to your workspace and check Library again, or ask the person who invited you for help." : "Ask the person who invited you to share a model, skill, or tool. You can continue to your workspace while they prepare your access."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </PageContent>
        ) : (
          <PageContent className="grow-0 overflow-visible">
            <div className="space-y-5" data-testid="onboarding-member-capabilities">
              {capabilities?.skills.length ? (
                <section aria-label="Skills shared with you">
                  <h2 className="text-xs font-medium text-muted-foreground">Skills</h2>
                  {capabilities.skills.map((skill) => (
                    <OnboardingResourceRow key={skill.path} title={skill.name} description={skill.description} />
                  ))}
                </section>
              ) : null}
              {connections.length > 0 ? (
                <section aria-label="Tools shared with you">
                  <h2 className="text-xs font-medium text-muted-foreground">Tools</h2>
                  {connections.map((connection) => {
                    const state = resolveOrgMcpConnectionCardState(connection);
                    const ready = state.connected && !connectionNeedsReconnect(connection) && !connection.issuerReviewRequired && !connection.setupRequired;
                    const adminSetup = connection.setupRequired || connection.issuerReviewRequired || connection.credentialMode === "shared" || connection.reconnectActionOwner === "organization_admin";
                    return (
                      <OnboardingResourceRow
                        key={connection.id}
                        title={connection.name}
                        description={ready
                          ? connection.credentialMode === "shared" ? "Managed by your team" : "Your account is connected"
                          : adminSetup ? "Ask your workspace admin to finish connecting this tool." : "Sign in with your own account in Library."}
                        status={ready ? "Ready" : adminSetup ? "Admin setup needed" : "Connect your account"}
                      />
                    );
                  })}
                </section>
              ) : null}
              {totalModels === 0 && !error ? (
                <p className="mt-4 rounded-xl border border-border p-3 text-sm text-muted-foreground">No team model is available to you yet. Ask the person who invited you about model access before starting a task.</p>
              ) : null}
            </div>
            {providers.length > 0 ? (
              <section aria-label="Team models" className="mt-3">
                <h2 className="text-xs font-medium text-muted-foreground">Models</h2>
                {providers.map((provider) => (
                  <ProviderCard key={provider.id} provider={provider} selectedDefault={selectedDefault} onSelectDefault={setSelectedDefault} />
                ))}
              </section>
            ) : null}
            {marketplaces.length > 0 ? (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer py-2 text-muted-foreground">Collections · {marketplaces.length}</summary>
                {marketplaces.map((marketplace) => <MarketplaceCard key={marketplace.id} marketplace={marketplace} />)}
              </details>
            ) : null}
            {/* Selected default indicator */}
            {selectedDefault ? (
              <p className="mt-2 text-xs text-muted-foreground">Default model: {selectedDefault.label}</p>
            ) : null}
          </PageContent>
        )}

        <PageFooter className="items-start border-t border-border pt-5">
          <Button
            className="w-fit"
            type="button"
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
      </div>
    </Page>
  );
}

interface MarketplaceCardProps {
  marketplace: DenOrgMarketplace;
}

function MarketplaceCard({ marketplace }: MarketplaceCardProps) {
  return <OnboardingResourceRow title={marketplace.name} description={marketplace.description} status={`${marketplace.pluginCount} plugin${marketplace.pluginCount === 1 ? "" : "s"}`} />;
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
    <OnboardingResourceRow
      title={resolveProviderDisplayName(provider.name || provider.providerId)}
      icon={<ProviderIcon providerId={provider.providerId} providerName={provider.name} size={18} />}
      description={provider.models.slice(0, 5).map((model) => model.name || resolveModelDisplayName(model.id)).join(" · ")}
      action={firstModel ? (
        <Button type="button" variant="ghost" size="sm" onClick={handleUseAsDefault}>
          {isSelected ? "Default" : "Use as default"}
        </Button>
      ) : null}
    />
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
      clearOrgSelectionPending();
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
      <PageTitlebarRegion />
      <PageContainer>
        <PageHeader>
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
