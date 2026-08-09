import {
  createDenClient,
  readDenSettings,
  seedDenDesktopConfigConnectPolicy,
  writeDenSettings,
  type DenDesktopHandoffExchange,
} from "./den";
import { dispatchDenSessionUpdated } from "./den-session-events";

type DenClient = ReturnType<typeof createDenClient>;
export const DEN_HANDOFF_AUTO_CONTINUE_KEY = "openwork.den.handoffAutoContinueAt";

export type HandoffActiveOrg = {
  id: string;
  slug?: string | null;
  name?: string | null;
};

export type ExchangeHandoffOptions = {
  /** Den base URL to exchange against (and persist on success). */
  baseUrl: string;
  /** Pre-built client to reuse. When omitted, a default client for `baseUrl` is created. */
  client?: DenClient;
  /** Optional active org to select on sign-in (bootstrap prepares this). */
  activeOrg?: HandoffActiveOrg | null;
  /** Message used when the exchange fails without a specific Error message. */
  fallbackErrorMessage?: string;
};

export type ExchangeHandoffResult =
  | { ok: true; exchange: DenDesktopHandoffExchange; baseUrl: string }
  | { ok: false; error: string };

/**
 * Single source of truth for the desktop handoff sign-in sequence:
 * exchange a one-time grant, persist the resulting session (and optional active
 * org) into Den settings, then broadcast `denSessionUpdated`.
 *
 * Used by every handoff entry point (deep link, manual paste, control action,
 * and the agent-first prepared bootstrap) so the exchange/persist/dispatch
 * logic is not re-implemented per call site.
 */
export async function exchangeHandoffAndSignIn(
  grant: string,
  options: ExchangeHandoffOptions,
): Promise<ExchangeHandoffResult> {
  const fallback = options.fallbackErrorMessage ?? "Failed to sign in to OpenWork Cloud.";
  const client = options.client ?? createDenClient({ baseUrl: options.baseUrl });

  try {
    const exchange = await client.exchangeDesktopHandoff(grant);
    if (!exchange.token) {
      throw new Error(fallback);
    }

    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(DEN_HANDOFF_AUTO_CONTINUE_KEY, String(Date.now()));
      } catch {}
    }
    // Prefer the caller-provided org (install-link bootstrap), then the org the
    // server resolved for this session. When neither is known, keep whatever is
    // already stored: overwriting with null strands fresh profiles without an
    // organization, which disables Connect and skips org onboarding.
    const activeOrg = options.activeOrg ?? exchange.organization ?? null;
    const storedSettings = readDenSettings();
    writeDenSettings({
      baseUrl: options.baseUrl,
      authToken: exchange.token,
      activeOrgId: activeOrg ? activeOrg.id : storedSettings.activeOrgId,
      activeOrgSlug: activeOrg ? activeOrg.slug ?? null : storedSettings.activeOrgSlug,
      activeOrgName: activeOrg ? activeOrg.name ?? null : storedSettings.activeOrgName,
    });
    if (exchange.organization) {
      seedDenDesktopConfigConnectPolicy({
        organizationId: exchange.organization.id,
        connectEnabled: exchange.connectEnabled,
      });
    }

    dispatchDenSessionUpdated({
      status: "success",
      baseUrl: options.baseUrl,
      token: exchange.token,
      user: exchange.user,
      email: exchange.user?.email ?? null,
    });

    return { ok: true, exchange, baseUrl: options.baseUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : fallback;
    dispatchDenSessionUpdated({ status: "error", message });
    return { ok: false, error: message };
  }
}
