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
  type AutomationDetail,
  type AutomationList,
  type AutomationSchedule,
} from "@openwork/types/automations";
import { z } from "zod";
import {
  cloudResponsibilityBody,
  parseDenLlmProviders,
  type CloudResponsibilityDraft,
  type DenLlmProvider,
} from "./cloud-responsibilities";

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
function denApiBase(baseUrl: string): string {
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

export function buildDenSignInUrl(baseUrl: string): string {
  const target = new URL(trimBase(baseUrl));
  target.searchParams.set("mode", "sign-in");
  // Den shows the copyable openwork:// grant handoff for desktop clients.
  target.searchParams.set("desktopAuth", "1");
  target.searchParams.set("desktopScheme", "openwork");
  return target.toString();
}

/** Accept a pasted openwork://den-auth deep link or a raw handoff grant. */
export function parsePastedGrant(value: string): { grant: string; baseUrl?: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    const tail = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean).pop() ?? "";
    const isAuthRoute = url.hostname.toLowerCase() === "den-auth" || tail === "den-auth";
    if ((protocol === "openwork:" || protocol === "openwork-dev:") && isAuthRoute) {
      const grant = url.searchParams.get("grant")?.trim() ?? "";
      const baseUrl = url.searchParams.get("denBaseUrl")?.trim() || undefined;
      return grant ? { grant, baseUrl } : null;
    }
  } catch {
    // Not a URL: treat as a raw grant below.
  }
  return trimmed.length >= 12 ? { grant: trimmed } : null;
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

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === "once") {
    return `Once at ${new Date(schedule.at).toLocaleString()}`;
  }
  if (schedule.kind === "daily") {
    return `Every day at ${formatTime(schedule.hour, schedule.minute)} (${schedule.timezone})`;
  }
  const days = schedule.daysOfWeek.map((day) => WEEKDAY_LABELS[day] ?? `day ${day}`).join(", ");
  return `Every ${days} at ${formatTime(schedule.hour, schedule.minute)} (${schedule.timezone})`;
}
