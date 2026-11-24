import {
  createDenClient,
  denOriginComparisonKey,
  readDenBootstrapConfig,
  readDenSettings,
  resolveDenBaseUrlsForDestination,
  seedDenDesktopConfigConnectPolicy,
  setDenBootstrapConfig,
  writeDenSettings,
  type DenBootstrapConfig,
  type DenDesktopHandoffExchange,
  type DenEnterpriseActivation,
} from "./den";
import { dispatchDenSessionUpdated } from "./den-session-events";
import { restoreRememberedDenOrganization } from "./den-org-memory";
import {
  clearDesktopSignInIntent,
  clearOrgSelectionPending,
  hasActiveDesktopSignInIntent,
  markOrgSelectionPending,
  resolveHandoffOrgPlan,
} from "./den-sign-in-intent";
import { noteSignInReturnHandoff } from "./den-sign-in-return";

export const DEN_HANDOFF_AUTO_CONTINUE_KEY = "openwork.den.handoffAutoContinueAt";

export type HandoffActiveOrg = {
  id: string;
  slug?: string | null;
  name?: string | null;
};

export type HandoffBootstrapCommit = {
  requireSignin?: boolean;
  enterpriseActivation?: DenEnterpriseActivation;
  clearHandoff?: boolean;
};

export type ExchangeHandoffOptions = {
  baseUrl: string;
  apiBaseUrl?: string | null;
  activeOrg?: HandoffActiveOrg | null;
  desktopInitiated?: boolean;
  fallbackErrorMessage?: string;
  bootstrap?: HandoffBootstrapCommit;
};

export type ExchangeHandoffResult =
  | { ok: true; exchange: DenDesktopHandoffExchange; baseUrl: string }
  | {
      ok: false;
      error: string;
      grantConsumed: boolean;
      stale: boolean;
    };

let handoffAttemptCounter = 0;
let commitQueue: Promise<unknown> = Promise.resolve();

export function beginDenEnrollment(options: { deferred?: boolean } = {}) {
  let attempt = handoffAttemptCounter;
  let activated = false;
  let cancelled = false;
  const isCurrent = () => !cancelled && attempt === handoffAttemptCounter;
  const activate = () => {
    if (!isCurrent()) return false;
    if (!activated) {
      attempt = ++handoffAttemptCounter;
      activated = true;
    }
    return true;
  };
  if (!options.deferred) activate();
  return {
    activate,
    isCurrent,
    cancel: () => {
      if (activated && isCurrent()) handoffAttemptCounter++;
      cancelled = true;
    },
  };
}

export type DenEnrollmentAttempt = ReturnType<typeof beginDenEnrollment>;

function bootstrapRestorePayload(previous: DenBootstrapConfig) {
  return {
    baseUrl: previous.baseUrl,
    apiBaseUrl: previous.apiBaseUrl,
    requireSignin: previous.requireSignin,
    ...(typeof previous.requireActivation === "boolean"
      ? { requireActivation: previous.requireActivation }
      : {}),
    ...(previous.brandAppName ? { brandAppName: previous.brandAppName } : {}),
    ...(previous.brandLogoUrl ? { brandLogoUrl: previous.brandLogoUrl } : {}),
    ...(previous.brandIconUrl ? { brandIconUrl: previous.brandIconUrl } : {}),
    ...(previous.claimLinks ? { claimLinks: previous.claimLinks } : {}),
    ...(previous.handoff ? { handoff: previous.handoff } : {}),
    ...(previous.prepared ? { prepared: previous.prepared } : {}),
    ...(previous.enterpriseActivation
      ? { enterpriseActivation: previous.enterpriseActivation }
      : {}),
  };
}

export async function exchangeHandoffAndSignIn(
  grant: string,
  options: ExchangeHandoffOptions,
): Promise<ExchangeHandoffResult> {
  const fallback = options.fallbackErrorMessage ?? "Failed to sign in to OpenWork Cloud.";
  const attempt = beginDenEnrollment();

  const fail = (
    error: string,
    input: { grantConsumed: boolean; stale?: boolean; publishError?: boolean },
  ): ExchangeHandoffResult => {
    if (input.publishError !== false) {
      dispatchDenSessionUpdated({ status: "error", message: error });
    }
    return { ok: false, error, grantConsumed: input.grantConsumed, stale: input.stale === true };
  };

  const storedSettings = readDenSettings();
  const sameOrigin =
    denOriginComparisonKey(storedSettings.baseUrl) === denOriginComparisonKey(options.baseUrl);
  let destination: Awaited<ReturnType<typeof resolveDenBaseUrlsForDestination>>;
  try {
    destination = await resolveDenBaseUrlsForDestination({
      baseUrl: options.baseUrl,
      apiBaseUrl: options.apiBaseUrl ?? (sameOrigin ? storedSettings.apiBaseUrl : undefined),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : fallback;
    return fail(message, { grantConsumed: false });
  }

  const client = createDenClient({
    baseUrl: destination.baseUrl,
    apiBaseUrl: destination.apiBaseUrl,
  });

  let exchange: DenDesktopHandoffExchange;
  try {
    exchange = await client.exchangeDesktopHandoff(grant);
  } catch (error) {
    const message = error instanceof Error ? error.message : fallback;
    return fail(message, { grantConsumed: false });
  }
  if (!exchange.token) {
    return fail(fallback, { grantConsumed: true });
  }

  return commitDenEnrollment({ attempt, destination, storedSettings, exchange, options });
}

export async function commitDenEnrollment(input: {
  attempt: DenEnrollmentAttempt;
  destination: Awaited<ReturnType<typeof resolveDenBaseUrlsForDestination>>;
  storedSettings: ReturnType<typeof readDenSettings>;
  exchange: DenDesktopHandoffExchange;
  options: ExchangeHandoffOptions;
  safeErrors?: boolean;
}): Promise<ExchangeHandoffResult> {
  const { attempt, destination, storedSettings, exchange, options } = input;
  const fallback = options.fallbackErrorMessage ?? "Failed to sign in to OpenWork Cloud.";
  const destinationKey = denOriginComparisonKey(destination.baseUrl);
  const apiBaseUrl = destination.apiBaseUrl;
  const sameOrigin = denOriginComparisonKey(storedSettings.baseUrl) === destinationKey;
  const fail = (
    error: string,
    details: { grantConsumed: boolean; stale?: boolean; publishError?: boolean },
  ): ExchangeHandoffResult => {
    const message = details.stale || !input.safeErrors ? error : fallback;
    if (details.publishError !== false) dispatchDenSessionUpdated({ status: "error", message });
    return { ok: false, error: message, grantConsumed: details.grantConsumed, stale: details.stale === true };
  };

  const commit = async (): Promise<ExchangeHandoffResult> => {
    if (!attempt.isCurrent()) {
      return fail("This sign-in was superseded by a newer attempt.", {
        grantConsumed: true,
        stale: true,
        publishError: false,
      });
    }

    const desktopInitiated = options.desktopInitiated ?? hasActiveDesktopSignInIntent();
    const rememberedOrganization = desktopInitiated && !options.activeOrg?.id?.trim() && exchange.user?.id
      ? await restoreRememberedDenOrganization({
          serverKey: destinationKey,
          userId: exchange.user.id,
          client: createDenClient({
            baseUrl: destination.baseUrl,
            apiBaseUrl,
            token: exchange.token,
          }),
          isCurrent: () => attempt.isCurrent(),
        })
      : null;
    if (!attempt.isCurrent()) {
      return fail("This sign-in was superseded by a newer attempt.", {
        grantConsumed: true,
        stale: true,
        publishError: false,
      });
    }
    const plan = resolveHandoffOrgPlan({
      explicitActiveOrg: options.activeOrg ?? null,
      exchangeOrganization: exchange.organization ?? null,
      desktopInitiated,
      rememberedOrganization,
    });

    const previousBootstrap = readDenBootstrapConfig();
    const bootstrapChangesOrigin =
      denOriginComparisonKey(previousBootstrap.baseUrl) !== destinationKey;
    const needsBootstrapCommit = bootstrapChangesOrigin || options.bootstrap !== undefined;
    if (needsBootstrapCommit) {
      const carryOriginScopedFields = !bootstrapChangesOrigin;
      const clearHandoff = options.bootstrap?.clearHandoff === true || bootstrapChangesOrigin;
      try {
        await setDenBootstrapConfig({
          baseUrl: destination.baseUrl,
          ...(apiBaseUrl ? { apiBaseUrl } : {}),
          requireSignin: options.bootstrap?.requireSignin ?? previousBootstrap.requireSignin,
          ...(typeof previousBootstrap.requireActivation === "boolean"
            ? { requireActivation: previousBootstrap.requireActivation }
            : {}),
          ...(carryOriginScopedFields && previousBootstrap.brandAppName
            ? { brandAppName: previousBootstrap.brandAppName }
            : {}),
          ...(carryOriginScopedFields && previousBootstrap.brandLogoUrl
            ? { brandLogoUrl: previousBootstrap.brandLogoUrl }
            : {}),
          ...(carryOriginScopedFields && previousBootstrap.brandIconUrl
            ? { brandIconUrl: previousBootstrap.brandIconUrl }
            : {}),
          ...(carryOriginScopedFields && previousBootstrap.claimLinks
            ? { claimLinks: previousBootstrap.claimLinks }
            : {}),
          handoff: clearHandoff ? null : previousBootstrap.handoff ?? null,
          ...(carryOriginScopedFields && previousBootstrap.prepared
            ? { prepared: previousBootstrap.prepared }
            : {}),
          enterpriseActivation: options.bootstrap?.enterpriseActivation
            ? options.bootstrap.enterpriseActivation
            : carryOriginScopedFields && previousBootstrap.enterpriseActivation
              ? previousBootstrap.enterpriseActivation
              : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : fallback;
        return fail(message, { grantConsumed: true });
      }

      if (denOriginComparisonKey(readDenBootstrapConfig().baseUrl) !== destinationKey) {
        await setDenBootstrapConfig(bootstrapRestorePayload(previousBootstrap)).catch(() => undefined);
        return fail(fallback, { grantConsumed: true });
      }
    }

    if (!attempt.isCurrent()) {
      if (needsBootstrapCommit) {
        await setDenBootstrapConfig(bootstrapRestorePayload(previousBootstrap)).catch(() => undefined);
      }
      return fail("This sign-in was superseded by a newer attempt.", {
        grantConsumed: true,
        stale: true,
        publishError: false,
      });
    }

    try {
      clearDesktopSignInIntent();
      if (plan.kind === "await-user-selection") {
        markOrgSelectionPending(plan.suggestion);
        writeDenSettings(
          {
            baseUrl: destination.baseUrl,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
            authToken: exchange.token,
            activeOrgId: null,
            activeOrgSlug: null,
            activeOrgName: null,
          },
          { persistBootstrap: false, intentionalActiveOrgClear: true },
        );
      } else {
        clearOrgSelectionPending();
        const activeOrg = plan.organization;
        const inheritStoredOrg = !activeOrg && sameOrigin;
        writeDenSettings(
          {
            baseUrl: destination.baseUrl,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
            authToken: exchange.token,
            activeOrgId: activeOrg ? activeOrg.id : inheritStoredOrg ? storedSettings.activeOrgId : null,
            activeOrgSlug: activeOrg
              ? activeOrg.slug ?? null
              : inheritStoredOrg
                ? storedSettings.activeOrgSlug
                : null,
            activeOrgName: activeOrg
              ? activeOrg.name ?? null
              : inheritStoredOrg
                ? storedSettings.activeOrgName
                : null,
          },
          {
            persistBootstrap: false,
            ...(activeOrg || inheritStoredOrg ? {} : { intentionalActiveOrgClear: true }),
          },
        );
      }
    } catch (error) {
      if (needsBootstrapCommit) {
        await setDenBootstrapConfig(bootstrapRestorePayload(previousBootstrap)).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : fallback;
      return fail(message, { grantConsumed: true });
    }

    if (exchange.organization) {
      seedDenDesktopConfigConnectPolicy({
        organizationId: exchange.organization.id,
        connectEnabled: exchange.connectEnabled,
      });
    }

    noteSignInReturnHandoff({ desktopInitiated });
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(DEN_HANDOFF_AUTO_CONTINUE_KEY, String(Date.now()));
      } catch {}
    }
    dispatchDenSessionUpdated({
      status: "success",
      baseUrl: destination.baseUrl,
      token: exchange.token,
      user: exchange.user,
      email: exchange.user?.email ?? null,
    });

    return { ok: true, exchange, baseUrl: destination.baseUrl };
  };

  const result = commitQueue.then(commit, commit);
  commitQueue = result.catch(() => undefined);
  return result;
}
