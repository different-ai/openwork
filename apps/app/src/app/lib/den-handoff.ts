import {
  createDenClient,
  writeDenSettings,
  type DenDesktopHandoffExchange,
} from "./den";
import { dispatchDenSessionUpdated } from "./den-session-events";

type DenClient = ReturnType<typeof createDenClient>;

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

    writeDenSettings({
      baseUrl: options.baseUrl,
      authToken: exchange.token,
      activeOrgId: options.activeOrg?.id ?? null,
      activeOrgSlug: options.activeOrg?.slug ?? null,
      activeOrgName: options.activeOrg?.name ?? null,
    });

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
