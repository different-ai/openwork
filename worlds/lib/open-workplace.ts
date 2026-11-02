import { randomBytes, randomUUID } from "node:crypto";
import { allocateFreePort } from "../../evals/packages/cdp/src/index.ts";
import { denFetch, type DenSession } from "../../evals/packages/behaviors/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import { connectDemoServer, startDemoScript, type DemoWorkspace } from "./demo-workspace.ts";

/**
 * Open Workplace (evals/packages/open-workplace): Open Outlook, Open Calendar, Open Drive, Open Jira and Open Confluence,
 * started next to Den and added to the org as ordinary shared MCP connections, one per app. Data stays in memory and is
 * seeded with the Acme Robotics sample organization, so whatever an agent writes can be read back from `/state`.
 */
export const OPEN_WORKPLACE_APPS = [
  { key: "open-outlook", name: "Open Outlook", service: "microsoft365", mcp: "/outlook/mcp" },
  { key: "open-calendar", name: "Open Calendar", service: "microsoft365", mcp: "/calendar/mcp" },
  { key: "open-drive", name: "Open Drive", service: "microsoft365", mcp: "/drive/mcp" },
  { key: "open-jira", name: "Open Jira", service: "atlassian", mcp: "/jira/mcp" },
  { key: "open-confluence", name: "Open Confluence", service: "atlassian", mcp: "/confluence/mcp" },
] as const;
export type OpenWorkplaceApp = (typeof OPEN_WORKPLACE_APPS)[number]["key"];

const SOURCE = new URL("../../evals/packages/open-workplace/src/", import.meta.url);
const SCRIPTS = {
  microsoft365: { url: new URL("microsoft365.mjs", SOURCE), label: "open-microsoft365", daytonaPort: 3993 },
  microsoftSignIn: { url: new URL("microsoft-signin.mjs", SOURCE), label: "open-workplace-signin", daytonaPort: 3994 },
  atlassian: { url: new URL("atlassian.mjs", SOURCE), label: "open-atlassian", daytonaPort: 3991 },
  atlassianWeb: { url: new URL("atlassian-web.mjs", SOURCE), label: "open-atlassian-web", daytonaPort: 3992 },
};

export interface OpenWorkplaceOptions {
  /** The signed-in person, "Display Name|handle|Title". Defaults to Alex Chen, the seeded Acme owner. */
  person?: string;
  /** Fixed ISO time for reproducible runs (also makes generated IDs deterministic). */
  now?: string;
  /**
   * The company's intranet domain, e.g. "acmerobotics.internal". Links then read http://office.<domain>/drive?item=… and
   * http://atlassian.<domain>/jira/browse/…; browsers reach them through `hostRules`. Local placement only.
   * Must be a reserved private name (.internal, .test, .example, .invalid, .localhost): anything that resolves on the
   * public internet would send an agent's uploads and fetches to whoever owns that domain.
   */
  domain?: string;
  /** Apps to add to the org as connections. Defaults to all five. */
  connect?: readonly OpenWorkplaceApp[];
}

export interface OpenWorkplace {
  /** Open Outlook, Open Calendar and Open Drive (Graph REST, MCP, web UI). */
  microsoft365: DemoWorkspace;
  /** Open Jira and Open Confluence (REST, MCP). */
  atlassian: DemoWorkspace;
  /** The Open Jira and Open Confluence web UI. */
  atlassianWeb: DemoWorkspace;
  /** Where a browser opens each app; public hostnames when `domain` is set. */
  urls: { outlook: string; calendar: string; drive: string; jira: string; confluence: string };
  /** Chrome --host-resolver-rules for `chrome({ hostRules })`; empty without `domain`. */
  hostRules: string;
}

export async function startOpenWorkplace(stack: AsyncDisposableStack, den: Den, options: OpenWorkplaceOptions = {}): Promise<OpenWorkplace> {
  const local = den.placement?.kind !== "daytona";
  if (options.domain && !local) throw new Error("Open Workplace hostnames need a local browser; omit `domain` on Daytona.");
  if (options.domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(internal|test|example|invalid|localhost)$/.test(options.domain)) {
    throw new Error(`Open Workplace domain ${JSON.stringify(options.domain)} must be a reserved private name (.internal, .test, .example, .invalid or .localhost) so nothing can reach a real host.`);
  }
  const env: Record<string, string> = {
    ...(options.person ? { OPEN_WORKPLACE_PERSON: options.person } : {}),
    ...(options.now ? { OPEN_WORKPLACE_NOW: options.now } : {}),
  };
  // Ports are chosen first so every service can hand out its final browser address from the start.
  const officePort = local ? await allocateFreePort() : undefined;
  const webPort = local ? await allocateFreePort() : undefined;
  const office = options.domain ? `http://office.${options.domain}` : officePort ? `http://127.0.0.1:${officePort}` : undefined;
  const atlassianOrigin = options.domain ? `http://atlassian.${options.domain}` : webPort ? `http://127.0.0.1:${webPort}` : undefined;

  const microsoft365 = await startDemoScript(stack, den, { ...SCRIPTS.microsoft365, localPort: officePort }, { ...env, ...(office ? { PUBLIC_URL: office } : {}) });
  const atlassian = await startDemoScript(stack, den, SCRIPTS.atlassian, {
    ...env, ...(atlassianOrigin ? { JIRA_PUBLIC_URL: `${atlassianOrigin}/jira`, CONFLUENCE_PUBLIC_URL: `${atlassianOrigin}/confluence` } : {}),
  });
  const atlassianWeb = await startDemoScript(stack, den, { ...SCRIPTS.atlassianWeb, localPort: webPort }, { ...env, ATLASSIAN_BASE_URL: atlassian.baseUrl });

  const connect = new Set(options.connect ?? OPEN_WORKPLACE_APPS.map((app) => app.key));
  for (const app of OPEN_WORKPLACE_APPS) {
    if (!connect.has(app.key)) continue;
    const base = app.service === "microsoft365" ? microsoft365.baseUrl : atlassian.baseUrl;
    await connectDemoServer(den, app.key, app.name, `${base}${app.mcp}`);
  }

  const officeUrl = office ?? microsoft365.baseUrl;
  const atlassianUrl = atlassianOrigin ?? atlassianWeb.baseUrl;
  return {
    microsoft365, atlassian, atlassianWeb,
    urls: { outlook: `${officeUrl}/outlook`, calendar: `${officeUrl}/calendar`, drive: `${officeUrl}/drive`, jira: `${atlassianUrl}/jira`, confluence: `${atlassianUrl}/confluence` },
    hostRules: options.domain ? `MAP office.${options.domain}:80 127.0.0.1:${officePort}, MAP atlassian.${options.domain}:80 127.0.0.1:${webPort}` : "",
  };
}

/**
 * Open Outlook, Open Calendar and Open Drive behind Den's ordinary Microsoft 365 connector: the same OAuth sign-in,
 * token refresh and Microsoft Graph calls Den makes against a real tenant, pointed at the Open Workplace sign-in
 * (evals/packages/open-workplace/src/microsoft-signin.mjs) instead. Each person gets their own backend, so what one
 * person's agent reads or writes is exactly what that person sees in Open Outlook, Open Calendar and Open Drive,
 * and never another person's. Sandbox only: Den's production endpoints stay Microsoft's unless these settings are
 * given at boot, and every identity is fictional. Local placement only (the consent page must reach the browser).
 */
export interface WorkplacePerson {
  /** Lowercase handle; the person's mailbox is <handle>@acme.test. */
  handle: string;
  name: string;
  title: string;
}

export interface MicrosoftSignInAddress {
  origin: string;
  port: number;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Den settings that send its Microsoft 365 connector here instead of Microsoft. Give them to Den at boot. */
  denEnv: Record<string, string>;
}

export interface MicrosoftWorkplacePerson extends WorkplacePerson {
  email: string;
  backend: DemoWorkspace;
  /** This person's own Open Outlook, Open Calendar and Open Drive. */
  urls: { outlook: string; calendar: string; drive: string };
}

export interface MicrosoftWorkplace {
  signIn: MicrosoftSignInAddress;
  people: MicrosoftWorkplacePerson[];
  person(handle: string): MicrosoftWorkplacePerson;
}

/** Den's Microsoft 365 permissions the sandbox turns on: read and write mail drafts, calendar and files. */
export const MICROSOFT_WORKPLACE_FEATURES = ["mailRead", "mailDraft", "calendarRead", "calendarWrite", "filesRead", "filesWrite"] as const;

/** Picks the sign-in address before Den boots, since Den reads its Microsoft endpoints at startup. */
export async function reserveMicrosoftSignIn(): Promise<MicrosoftSignInAddress> {
  const port = await allocateFreePort();
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin, port, tenantId: randomUUID(),
    clientId: `open-workplace-${randomBytes(6).toString("hex")}`, clientSecret: randomBytes(24).toString("base64url"),
    denEnv: {
      DEN_MICROSOFT_OAUTH_AUTHORIZE_URL: `${origin}/{tenantId}/oauth2/v2.0/authorize`,
      DEN_MICROSOFT_OAUTH_TOKEN_URL: `${origin}/{tenantId}/oauth2/v2.0/token`,
      DEN_MICROSOFT_GRAPH_BASE_URL: `${origin}/v1.0`,
    },
  };
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.entries(value).find(([name]) => name === key)?.[1];
}

/**
 * Adds Microsoft 365 to the org's connectors with the sandbox's OAuth app (as an admin does on the Connectors page),
 * then starts one Open
 * Workplace backend per person and the sign-in in front of them, registered for Den's exact callback.
 */
export async function startMicrosoftWorkplace(stack: AsyncDisposableStack, den: Den, input: { signIn: MicrosoftSignInAddress; people: readonly WorkplacePerson[]; now?: string }): Promise<MicrosoftWorkplace> {
  if (den.placement?.kind === "daytona") throw new Error("The Open Workplace Microsoft 365 sandbox runs with local placement only.");
  const { signIn } = input;
  const headers = { authorization: `Bearer ${den.admin.token}` };
  // The Connectors page's path: add Microsoft 365 as a connector with the OAuth app, then save its tenant.
  const created = await denFetch(den.ref, "/v1/mcp-connections", {
    method: "POST", headers,
    body: JSON.stringify({ kind: "native_provider", nativeProviderKey: "microsoft-365", name: "Microsoft 365", oauthClient: { clientId: signIn.clientId, clientSecret: signIn.clientSecret, features: MICROSOFT_WORKPLACE_FEATURES } }),
  });
  const connectionId = field(field(created.body, "connection") ?? created.body, "id");
  if (!created.response.ok || typeof connectionId !== "string") throw new Error(`Could not add the Microsoft 365 connector: HTTP ${created.response.status} ${created.text.slice(0, 200)}`);
  const client = `/v1/oauth-providers/${encodeURIComponent(connectionId)}/client`;
  const tenant = await denFetch(den.ref, client, { method: "POST", headers, body: JSON.stringify({ tenantId: signIn.tenantId }) });
  if (!tenant.response.ok) throw new Error(`Could not save the Microsoft 365 tenant: HTTP ${tenant.response.status} ${tenant.text.slice(0, 200)}`);
  const saved = await denFetch(den.ref, client, { headers });
  const redirectUri = field(saved.body, "redirectUri");
  if (!saved.response.ok || typeof redirectUri !== "string") throw new Error(`Den did not report its Microsoft 365 callback: HTTP ${saved.response.status}`);

  const people: MicrosoftWorkplacePerson[] = [];
  for (const person of input.people) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(person.handle)) throw new Error(`Invalid workplace handle ${person.handle}`);
    const backend = await startDemoScript(stack, den, { ...SCRIPTS.microsoft365, label: `open-microsoft365-${person.handle}` }, {
      OPEN_WORKPLACE_PERSON: `${person.name}|${person.handle}|${person.title}`, ...(input.now ? { OPEN_WORKPLACE_NOW: input.now } : {}),
    });
    people.push({ ...person, email: `${person.handle}@acme.test`, backend, urls: { outlook: `${backend.baseUrl}/outlook`, calendar: `${backend.baseUrl}/calendar`, drive: `${backend.baseUrl}/drive` } });
  }
  await startDemoScript(stack, den, { ...SCRIPTS.microsoftSignIn, localPort: signIn.port }, {
    PUBLIC_URL: signIn.origin,
    OPEN_WORKPLACE_SIGNIN: JSON.stringify({
      tenantId: signIn.tenantId, clientId: signIn.clientId, clientSecret: signIn.clientSecret, redirectUris: [redirectUri],
      people: people.map((person) => ({ handle: person.handle, name: person.name, email: person.email, graph: person.backend.baseUrl })),
    }),
  });
  return {
    signIn, people,
    person(handle) {
      const found = people.find((person) => person.handle === handle);
      if (!found) throw new Error(`No workplace person ${handle}`);
      return found;
    },
  };
}

/**
 * Connects one member's Microsoft 365 the way they would: Den's Connect, the sign-in's consent page (choosing who
 * signs in and allowing access), then Den's callback. Returns the account Den recorded.
 */
export async function connectMicrosoftMember(session: DenSession, orgId: string, handle: string): Promise<string> {
  const headers = { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
  const started = await denFetch(session, "/v1/oauth-providers/microsoft-365/connect/start", { headers });
  const authorizeUrl = field(started.body, "authorizeUrl");
  if (!started.response.ok || typeof authorizeUrl !== "string") throw new Error(`Microsoft 365 connect did not start: HTTP ${started.response.status} ${started.text.slice(0, 200)}`);
  const page = await fetch(authorizeUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const request = (await page.text()).match(/name="request" value="([^"]+)"/)?.[1];
  if (page.status !== 200 || !request) throw new Error(`The sign-in consent page did not open: HTTP ${page.status}`);
  const approved = await fetch(authorizeUrl.split("?")[0] ?? authorizeUrl, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, person: handle, decision: "allow" }),
  });
  const callback = approved.headers.get("location");
  if (approved.status !== 302 || !callback) throw new Error(`The sign-in did not return to Den: HTTP ${approved.status}`);
  const finished = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const result = await finished.text();
  if (finished.status !== 200) throw new Error(`Den did not finish the Microsoft 365 connection: HTTP ${finished.status} ${result.slice(0, 300)}`);
  const status = await denFetch(session, "/v1/oauth-providers/microsoft-365/status", { headers });
  const account = field(status.body, "externalAccountId");
  if (!status.response.ok || field(status.body, "connected") !== true || typeof account !== "string") throw new Error(`Microsoft 365 is not connected after sign-in: HTTP ${status.response.status} ${status.text.slice(0, 200)}`);
  return account;
}
