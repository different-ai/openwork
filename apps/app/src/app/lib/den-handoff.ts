import { OPENWORK_OPERATION_DEADLINES } from "@openwork/types/operation-deadlines";
import {
  createDenClient,
  writeDenSettings,
  type DenDesktopHandoffExchange,
} from "./den";
import { dispatchDenSessionUpdated } from "./den-session-events";

type DenClient = ReturnType<typeof createDenClient>;

const HANDOFF_REQUEST_STORAGE_KEY = "openwork.den.handoff.request.v1";

type HandoffRequestRecord = {
  fingerprint: string;
  requestId: string;
};

let retainedRequest: HandoffRequestRecord | null = null;

async function grantFingerprint(grant: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(grant),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readStoredRequest(): HandoffRequestRecord | null {
  if (typeof window === "undefined") return retainedRequest;
  try {
    const raw = window.localStorage.getItem(HANDOFF_REQUEST_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      parsed
      && typeof parsed === "object"
      && "fingerprint" in parsed
      && typeof parsed.fingerprint === "string"
      && "requestId" in parsed
      && typeof parsed.requestId === "string"
    ) {
      return { fingerprint: parsed.fingerprint, requestId: parsed.requestId };
    }
  } catch {
    // Retaining the request id in memory still makes same-process retries safe.
  }
  return retainedRequest;
}

function writeStoredRequest(record: HandoffRequestRecord): void {
  retainedRequest = record;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HANDOFF_REQUEST_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // The in-memory record remains authoritative for this app process.
  }
}

async function handoffRequestId(grant: string): Promise<HandoffRequestRecord> {
  const fingerprint = await grantFingerprint(grant);
  const current = readStoredRequest();
  if (current?.fingerprint === fingerprint) return current;
  const next = { fingerprint, requestId: globalThis.crypto.randomUUID() };
  writeStoredRequest(next);
  return next;
}

function clearHandoffRequest(record: HandoffRequestRecord): void {
  if (retainedRequest?.requestId === record.requestId) retainedRequest = null;
  if (typeof window === "undefined") return;
  try {
    const current = readStoredRequest();
    if (current?.requestId === record.requestId) {
      window.localStorage.removeItem(HANDOFF_REQUEST_STORAGE_KEY);
    }
  } catch {
    // Best-effort cleanup. The id is not a credential and expires with its grant.
  }
}

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
  const request = await handoffRequestId(grant);

  try {
    const exchange = await client.exchangeDesktopHandoff(grant, {
      requestId: request.requestId,
      deadlineMs: OPENWORK_OPERATION_DEADLINES.denHandoffExchangeMs,
    });
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
    clearHandoffRequest(request);

    return { ok: true, exchange, baseUrl: options.baseUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : fallback;
    dispatchDenSessionUpdated({ status: "error", message });
    return { ok: false, error: message };
  }
}
