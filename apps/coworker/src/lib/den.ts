/**
 * Narrow Den (OpenWork Cloud) client for Open Coworker.
 *
 * Open Coworker is a Den client exactly like the OpenWork desktop: Den owns
 * accounts, organizations, Automations, schedules, and run history. This
 * module implements only the slice Open Coworker uses, typed by the shared
 * `@openwork/types/automations` wire contracts. Promoting the full desktop
 * Den client into a shared package is the designated follow-up extraction.
 */
import {
  AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER,
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  automationDetailSchema,
  automationListSchema,
  automationRunSchema,
  type AutomationDetail,
  type AutomationList,
  type AutomationRun,
} from "@openwork/types/automations";
import { z } from "zod";

/** `POST /v1/mcp/token` — the minted gateway token plus the resource it is valid for. */
const connectTokenSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().min(1),
  organizationId: z.string().min(1),
  resource: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  appHostToken: z.string().optional(),
  appHostExpiresAt: z.string().optional(),
});
export type ConnectToken = z.infer<typeof connectTokenSchema>;

/** `GET /v1/automations/:id/runs` — the same page shape the OpenWork desktop reads. */
const automationRunListSchema = z.object({
  items: z.array(automationRunSchema),
  nextCursor: z.string().nullable(),
});
import {
  cloudResponsibilityBody,
  parseDenLlmProviders,
  type CloudResponsibilityDraft,
  type DenLlmProvider,
} from "./cloud-responsibilities.ts";

const STORAGE_KEY = "coworker.den.session.v1";
const ORG_SCOPE_HEADER = "x-openwork-org-id";
const ORG_PROXY_HEADER = "x-openwork-legacy-org-id";

export type DenSession = {
  baseUrl: string;
  token: string;
  userName: string;
  userEmail: string;
  orgId: string;
  orgName: string;
};

const denSessionSchema = z.object({
  baseUrl: z.string().min(1),
  token: z.string().min(1),
  userName: z.string(),
  userEmail: z.string(),
  orgId: z.string(),
  orgName: z.string(),
});

export function readDenSession(): DenSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return denSessionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeDenSession(session: DenSession | null): void {
  if (!session) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

const HOSTED_DEN_APEX_HOST = "openworklabs.com";

/**
 * The deterministic API origin for a Den base URL — the same rule the
 * OpenWork desktop applies: an explicit `api.*` host is already the API
 * origin, hosted OpenWork Cloud (`*.openworklabs.com`) serves its API at the
 * `api.`-prefixed host, and any other (self-hosted) Den is reached through
 * its `/api/den` proxy path.
 */
export function denApiBase(baseUrl: string): string {
  const web = trimBase(baseUrl);
  try {
    const url = new URL(web);
    const hostname = url.hostname.toLowerCase();
    const isExplicitApiHost = hostname === "api" || hostname.startsWith("api.");
    const isHosted = hostname === HOSTED_DEN_APEX_HOST || hostname.endsWith(`.${HOSTED_DEN_APEX_HOST}`);
    if (isExplicitApiHost) return url.origin;
    if (isHosted) {
      url.hostname = `api.${hostname}`;
      return url.origin;
    }
  } catch {
    // Fall through to the proxy-path shape.
  }
  return `${web}/api/den`;
}

/** `/v1/*` lives on the Den API origin; everything else on the web origin. */
function requestBase(baseUrl: string, path: string): string {
  return path.startsWith("/v1/") ? denApiBase(baseUrl) : trimBase(baseUrl);
}

/** Deep-link schemes whose `den-auth` handoff this app accepts, pasted or delivered by the OS. */
const HANDOFF_PROTOCOLS = new Set(["opencoworker:", "opencoworker-dev:", "openwork:", "openwork-dev:"]);

/**
 * The same hosted Den sign-in the OpenWork desktop opens. `desktopScheme` makes
 * Den build the handoff link with this app's own scheme, so "Open in app"
 * returns here instead of to an OpenWork desktop installed beside it; the copy
 * button on that page remains the paste path for unregistered (dev) builds.
 */
export function buildDenSignInUrl(baseUrl: string, deepLinkScheme = "opencoworker"): string {
  const target = new URL(trimBase(baseUrl));
  target.searchParams.set("mode", "sign-in");
  target.searchParams.set("desktopAuth", "1");
  target.searchParams.set("desktopScheme", deepLinkScheme);
  return target.toString();
}

/** Accept a pasted or deep-linked `…://den-auth` handoff, or a raw handoff grant. */
export function parsePastedGrant(value: string): { grant: string; baseUrl?: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    const tail = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean).pop() ?? "";
    const isAuthRoute = url.hostname.toLowerCase() === "den-auth" || tail === "den-auth";
    if (HANDOFF_PROTOCOLS.has(protocol) && isAuthRoute) {
      const grant = url.searchParams.get("grant")?.trim() ?? "";
      const baseUrl = url.searchParams.get("denBaseUrl")?.trim() || undefined;
      return grant ? { grant, baseUrl } : null;
    }
    // Any other URL with a host (a web page, an unrelated deep link) is not a grant.
    if (url.hostname) return null;
  } catch {
    // Not a URL: treat as a raw grant below.
  }
  return trimmed.length >= 12 ? { grant: trimmed } : null;
}

/** The session shape the embedded server's provider sync stores: API origin, token, organization. */
export function providerSyncSession(session: DenSession): { baseUrl: string; token: string; orgId: string } {
  return { baseUrl: denApiBase(session.baseUrl), token: session.token, orgId: session.orgId };
}

export type CloudProviderSyncStatus = {
  hasSession: boolean;
  lastRun: { at: string; status: "applied" | "noop" | "failed"; message?: string } | null;
  /** Providers the account materialized into this engine, keyed by their engine provider id. */
  providers: Array<{ providerId: string; name: string; source: string | null; modelIds: string[] }>;
  /** Materialized on disk but not yet served: the engine reload is still owed. */
  reloadPending: boolean;
  /** Granted by the organization but not usable here yet, each with the reason. */
  skippedProviders: Array<{ providerId: string; name: string; reason: "missing_credentials" | "needs_key" }>;
};

const cloudProviderSyncStatusSchema = z.object({
  hasSession: z.boolean(),
  lastRun: z
    .object({
      at: z.string(),
      status: z.enum(["applied", "noop", "failed"]),
      message: z.string().optional(),
    })
    .nullable(),
  providers: z.array(
    z.object({
      providerId: z.string(),
      name: z.string(),
      source: z.string().nullable(),
      modelIds: z.array(z.string()),
    }).loose(),
  ),
  reloadPending: z.boolean().default(false),
  skippedProviders: z
    .array(z.object({ providerId: z.string(), name: z.string(), reason: z.enum(["missing_credentials", "needs_key"]) }))
    .default([]),
});

/**
 * What the embedded server has done with the signed-in account's providers.
 * Read from the same status route the OpenWork desktop consults, so the
 * Coworker UI never guesses whether an organization model is really usable.
 */
export async function readCloudProviderSyncStatus(options: {
  serverUrl: string;
  token: string;
}): Promise<CloudProviderSyncStatus> {
  const response = await fetch(`${trimBase(options.serverUrl)}/cloud-provider-sync/status`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Reading the OpenWork provider status failed (${response.status})`);
  return cloudProviderSyncStatusSchema.parse(await response.json());
}

/** Plain-language reason a granted provider is not usable in this engine yet. */
export function describeSkippedProvider(reason: "missing_credentials" | "needs_key"): string {
  return reason === "needs_key"
    ? "Needs your own key in OpenWork before it can run here."
    : "Your organization has not attached a credential yet.";
}

type DenRequestOptions = {
  method?: string;
  token?: string;
  orgId?: string;
  body?: unknown;
};

export class DenError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function denRequest(baseUrl: string, path: string, options: DenRequestOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.orgId) {
    headers[ORG_SCOPE_HEADER] = options.orgId;
    headers[ORG_PROXY_HEADER] = options.orgId;
  }
  headers[AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER] = AUTOMATION_MODEL_ATTENTION_CAPABILITY;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${requestBase(baseUrl, path)}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : `Den request failed (${response.status})`;
    throw new DenError(response.status, message);
  }
  return payload;
}

const exchangeSchema = z.object({
  token: z.string().min(1),
  user: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
  organization: z.object({ id: z.string(), name: z.string().optional() }).nullable().optional(),
});

const orgsSchema = z.object({
  orgs: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
  activeOrgId: z.string().nullable().optional(),
});

export async function exchangeGrant(baseUrl: string, grant: string): Promise<DenSession> {
  const payload = exchangeSchema.parse(
    await denRequest(baseUrl, "/v1/auth/desktop-handoff/exchange", {
      method: "POST",
      body: { grant },
    }),
  );
  let orgId = payload.organization?.id ?? "";
  let orgName = payload.organization?.name ?? "";
  if (!orgId) {
    const orgs = orgsSchema.parse(await denRequest(baseUrl, "/v1/me/orgs", { token: payload.token }));
    const active = orgs.orgs.find((org) => org.id === orgs.activeOrgId) ?? orgs.orgs[0];
    orgId = active?.id ?? "";
    orgName = active?.name ?? "";
  }
  return {
    baseUrl: trimBase(baseUrl),
    token: payload.token,
    userName: payload.user?.name ?? "",
    userEmail: payload.user?.email ?? "",
    orgId,
    orgName,
  };
}

export type ResponsibilityDraft = CloudResponsibilityDraft;

export function createDenAutomationsClient(session: DenSession) {
  const { baseUrl, token, orgId } = session;
  return {
    async list(): Promise<AutomationList> {
      const payload = await denRequest(baseUrl, "/v1/automations?limit=50", { token, orgId });
      return automationListSchema.parse(payload);
    },
    /** Models a Cloud run may use: Den's member-scoped provider list. */
    async listCloudProviders(): Promise<DenLlmProvider[]> {
      return parseDenLlmProviders(await denRequest(baseUrl, "/v1/llm-providers", { token, orgId }));
    },
    /**
     * Cloud placement is decided by the creation surface, so this must be the
     * Cloud endpoint: the legacy `/v1/automations` body would create a
     * desktop-placed Automation that Open Coworker cannot execute.
     */
    async create(draft: ResponsibilityDraft): Promise<AutomationDetail> {
      const payload = await denRequest(baseUrl, "/v1/cloud-automations", {
        method: "POST",
        token,
        orgId,
        body: cloudResponsibilityBody(draft),
      });
      return automationDetailSchema.parse(payload);
    },
    /**
     * A short-lived bearer token for the OpenWork Connect gateway (`/mcp/agent`),
     * the same one the OpenWork desktop mints before registering the gateway.
     */
    async mintMcpToken(): Promise<ConnectToken> {
      const payload = await denRequest(baseUrl, "/v1/mcp/token", {
        method: "POST",
        token,
        orgId,
        body: { scopes: ["mcp:read", "mcp:write"] },
      });
      return connectTokenSchema.parse(payload);
    },
    /** Recent runs of one Automation, newest first, with Den's own result summaries. */
    async listRuns(automationId: string, limit = 12): Promise<AutomationRun[]> {
      const payload = await denRequest(
        baseUrl,
        `/v1/automations/${encodeURIComponent(automationId)}/runs?limit=${encodeURIComponent(String(limit))}`,
        { token, orgId },
      );
      return automationRunListSchema.parse(payload).items;
    },
    async runNow(automationId: string): Promise<void> {
      await denRequest(baseUrl, `/v1/automations/${encodeURIComponent(automationId)}/run`, {
        method: "POST",
        token,
        orgId,
        body: {},
      });
    },
    async setActive(automationId: string, active: boolean): Promise<AutomationDetail> {
      const payload = await denRequest(
        baseUrl,
        `/v1/automations/${encodeURIComponent(automationId)}/${active ? "activate" : "deactivate"}`,
        { method: "POST", token, orgId, body: {} },
      );
      return automationDetailSchema.parse(payload);
    },
  };
}
