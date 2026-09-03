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
import {
  clearDesktopSignInIntent,
  clearOrgSelectionPending,
  hasActiveDesktopSignInIntent,
  markOrgSelectionPending,
  resolveHandoffOrgPlan,
} from "./den-sign-in-intent";

export const DEN_HANDOFF_AUTO_CONTINUE_KEY = "openwork.den.handoffAutoContinueAt";

export type HandoffActiveOrg = {
  id: string;
  slug?: string | null;
  name?: string | null;
};

/**
 * Bootstrap fields the caller wants persisted in the same durable commit as
 * the handoff enrollment, instead of as a separate follow-up write that could
 * be lost after the session already switched.
 */
export type HandoffBootstrapCommit = {
  /** Force the persisted bootstrap's requireSignin flag. */
  requireSignin?: boolean;
  /** Stamp an enterprise activation into the committed bootstrap. */
  enterpriseActivation?: DenEnterpriseActivation;
  /** Strip a consumed one-time bootstrap grant in the same commit. */
  clearHandoff?: boolean;
};

export type ExchangeHandoffOptions = {
  /** Den base URL to exchange against (and persist on success). */
  baseUrl: string;
  /** Direct Den API base to exchange against and preserve on success. */
  apiBaseUrl?: string | null;
  /** Optional active org to select on sign-in (bootstrap prepares this). */
  activeOrg?: HandoffActiveOrg | null;
  /**
   * How this sign-in started. Desktop-initiated flows (in-app sign-in
   * buttons, pasted one-time codes) defer the organization choice to the org
   * onboarding step instead of adopting the exchange-reported org. When
   * omitted, the short-lived desktop sign-in intent marker decides;
   * automation surfaces pass `false` to keep committing directly.
   */
  desktopInitiated?: boolean;
  /** Message used when the exchange fails without a specific Error message. */
  fallbackErrorMessage?: string;
  /** Extra bootstrap fields to persist atomically with the enrollment. */
  bootstrap?: HandoffBootstrapCommit;
};

export type ExchangeHandoffResult =
  | { ok: true; exchange: DenDesktopHandoffExchange; baseUrl: string }
  | {
      ok: false;
      error: string;
      /**
       * True when the one-time grant was already sent to (and consumed by)
       * the destination. A consumed grant must not be retried; the user needs
       * a fresh handoff link instead.
       */
      grantConsumed: boolean;
      /** True when a newer handoff attempt superseded this one. */
      stale: boolean;
    };

// Handoff attempts are numbered so a late result from an older attempt can
// never replace a newer enrollment, and commits are serialized so two
// in-flight attempts can never interleave their persistence steps.
let handoffAttemptCounter = 0;
let commitQueue: Promise<unknown> = Promise.resolve();

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

/**
 * Single source of truth for the desktop handoff sign-in sequence, used by
 * every handoff entry point (deep link, manual paste, control action, and the
 * agent-first prepared bootstrap).
 *
 * A cross-server handoff is a transaction: the control-plane origin, session
 * credential, active organization, and enrollment generation become active
 * together, or none of them do. The phases are:
 *
 * 1. Prepare — resolve the expected destination (including the API base the
 *    destination publishes) and number the attempt.
 * 2. Validate — exchange the grant with a client constructed from that
 *    resolved destination, so the credential can only come from the origin
 *    this transaction would persist.
 * 3. Durable commit — persist the destination bootstrap (plus any
 *    caller-requested bootstrap fields) and confirm the committed bootstrap
 *    is the intended destination before anything becomes active.
 * 4. Activate — publish origin, token, and organization to the active
 *    session in one write. The previous organization never carries across
 *    origins; only a destination-provided organization (or a same-origin
 *    stored one) is selected.
 * 5. Publish — only after the durable commit, broadcast success.
 *
 * Any failure after preparation leaves the previously active enrollment
 * untouched (rolling the bootstrap back if it was already switched), and a
 * stale attempt — one superseded by a newer handoff — never activates or
 * publishes anything.
 */
export async function exchangeHandoffAndSignIn(
  grant: string,
  options: ExchangeHandoffOptions,
): Promise<ExchangeHandoffResult> {
  const fallback = options.fallbackErrorMessage ?? "Failed to sign in to OpenWork Cloud.";
  const attempt = ++handoffAttemptCounter;

  const fail = (
    error: string,
    input: { grantConsumed: boolean; stale?: boolean; publishError?: boolean },
  ): ExchangeHandoffResult => {
    if (input.publishError !== false) {
      dispatchDenSessionUpdated({ status: "error", message: error });
    }
    return { ok: false, error, grantConsumed: input.grantConsumed, stale: input.stale === true };
  };

  // Phase 1: prepare. Resolve the expected destination once; the exchange
  // client, the durable bootstrap commit, and the activated session all use
  // this same resolution, so they cannot diverge.
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
  const destinationKey = denOriginComparisonKey(destination.baseUrl);
  const apiBaseUrl = destination.apiBaseUrl;

  // Phase 2: exchange with a client constructed from the resolved
  // destination, so the grant can only be sent to — and the credential can
  // only come from — the origin this transaction would persist.
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

  // Phases 3-5 run serialized: one commit at a time, newest attempt wins.
  const commit = async (): Promise<ExchangeHandoffResult> => {
    if (attempt !== handoffAttemptCounter) {
      // A newer handoff attempt owns the enrollment now. Do not activate or
      // publish anything from this one.
      return fail("This sign-in was superseded by a newer attempt.", {
        grantConsumed: true,
        stale: true,
        publishError: false,
      });
    }

    const desktopInitiated = options.desktopInitiated ?? hasActiveDesktopSignInIntent();
    const plan = resolveHandoffOrgPlan({
      explicitActiveOrg: options.activeOrg ?? null,
      exchangeOrganization: exchange.organization ?? null,
      desktopInitiated,
    });

    // Phase 3: durable bootstrap commit before any active-session write. The
    // current enrollment stays authoritative until the destination bootstrap
    // is persisted and confirmed.
    const previousBootstrap = readDenBootstrapConfig();
    const bootstrapChangesOrigin =
      denOriginComparisonKey(previousBootstrap.baseUrl) !== destinationKey;
    const needsBootstrapCommit = bootstrapChangesOrigin || options.bootstrap !== undefined;
    if (needsBootstrapCommit) {
      // Branding, claim links, and prepared-workspace state belong to the
      // origin that wrote them; they carry through same-origin commits only.
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
          // The activation stamp is origin-scoped. Cross-origin commits clear
          // it explicitly: omitting it would let the persist layer retain the
          // previous origin's stamp and mark the new control plane as already
          // activated.
          enterpriseActivation: options.bootstrap?.enterpriseActivation
            ? options.bootstrap.enterpriseActivation
            : carryOriginScopedFields && previousBootstrap.enterpriseActivation
              ? previousBootstrap.enterpriseActivation
              : null,
        });
      } catch (error) {
        // Nothing was activated: the previous enrollment (origin, token, and
        // organization) is still complete and authoritative.
        const message = error instanceof Error ? error.message : fallback;
        return fail(message, { grantConsumed: true });
      }

      // Confirm the committed bootstrap is the intended destination before
      // promoting the credential. A divergent read-back means the durable
      // state is not what this transaction validated.
      if (denOriginComparisonKey(readDenBootstrapConfig().baseUrl) !== destinationKey) {
        await setDenBootstrapConfig(bootstrapRestorePayload(previousBootstrap)).catch(() => undefined);
        return fail(fallback, { grantConsumed: true });
      }
    }

    // Phase 4: activate. One synchronous write publishes origin, token, and
    // organization together. Roll the bootstrap back if it cannot complete.
    try {
      clearDesktopSignInIntent();
      if (plan.kind === "await-user-selection") {
        // Desktop-initiated sign-in: hold the org choice for the onboarding
        // step. The exchange-reported org is only the chooser's default;
        // single-org accounts still auto-select there without a visible stop.
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
        // Prefer the caller-provided org (install-link bootstrap), then the
        // org the destination resolved for this session. Without either, a
        // same-origin handoff keeps the stored organization, but an
        // organization never carries into a different origin: the destination
        // must prove or return its own.
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

    // Phase 5: publish success only after the durable commit and activation.
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
