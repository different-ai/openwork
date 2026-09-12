import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { notImplemented } from "@openwork/labs";

export type DenRef = { apiUrl: string; webUrl: string };
export type DenSession = DenRef & { token: string; email: string; password: string };
export type ConnectionFacts = { id: string; name: string; connectedForMe: boolean | null; connectedAt: string | null };
export type DenFetchResult = { response: Response; body: unknown; text: string };

export interface NativeConnectorInput {
  providerKey: string;
  name: string;
  clientId: string;
  clientSecret: string;
  features?: string[];
  access?: { orgWide?: boolean };
}

export interface ProvisionOrgInput {
  connectors?: string[];
  members?: string[];
}

export interface ProvisionedOrg {
  admin: DenSession;
  orgId: string;
}

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
// Two 300s header stalls were observed on fresh-sandbox first contact.
const DEFAULT_DEN_FETCH_TIMEOUT_MS = 30_000;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  return typeof value[key] === "string" ? value[key] : null;
}

function preview(value: unknown): string {
  return (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).slice(0, 500);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

export async function denFetch(den: DenRef, path: string, init: RequestInit = {}): Promise<DenFetchResult> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("origin")) headers.set("origin", den.webUrl);
  const response = await fetch(`${trimTrailingSlashes(den.apiUrl)}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(DEFAULT_DEN_FETCH_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

/**
 * A Daytona preview URL carries a signed, expiring token in its hostname, and
 * the proxy answers an expired one with its own 401 before the request ever
 * reaches Den. That is indistinguishable from rejected credentials in the
 * failure text, so a stale reused URL reads as "wrong password" and sends the
 * reader hunting through Den auth. Name the real cause instead.
 */
export function expiredPreviewUrlHint(url: string, status: number, body: unknown): string {
  if (status !== 401) return "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  if (!/\.daytonaproxy\d*\.net$/i.test(host)) return "";
  const code = typeof body === "object" && body !== null && "code" in body
    ? String((body as { code?: unknown }).code ?? "")
    : "";
  if (code && code.toUpperCase() !== "UNAUTHORIZED") return "";
  return " The Daytona preview URL looks expired (the proxy rejected the request before Den saw it)."
    + " Re-provision the Den sandbox or re-mint its preview URLs, then update OPENWORK_EVAL_DEN_API_URL/_WEB_URL.";
}

export async function signIn(den: DenRef, credentials: { email: string; password: string }): Promise<DenSession> {
  const result = await denFetch(den, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
  const token = stringField(result.body, "token");
  if (!result.response.ok || !token) {
    const hint = expiredPreviewUrlHint(den.apiUrl, result.response.status, result.body);
    throw new Error(
      `Sign-in failed for ${credentials.email}: HTTP ${result.response.status} ${preview(result.body)}${hint}`,
    );
  }
  return { ...den, token, email: credentials.email, password: credentials.password };
}

/** Refresh an eval session using the credentials captured by signIn. */
export async function freshSession(session: DenSession): Promise<DenSession> {
  return signIn(session, { email: session.email, password: session.password });
}

export function doInternalMarkEmailVerified(command: string, email: string): void {
  if (!command.trim()) throw new Error("OPENWORK_EVAL_MARK_VERIFIED_CMD is required to verify a newly-created member.");
  try {
    execSync(command.replaceAll("{email}", email), { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const stdout = isRecord(error) && typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr.trim() : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Marking ${email} verified failed: ${message}\nstdout: ${stdout || "(empty)"}\nstderr: ${stderr || "(empty)"}`,
    );
  }
}

export async function ensureMemberSession(
  den: DenRef,
  admin: DenSession,
  input: { email: string; password: string; name?: string; markVerifiedCmd?: string },
): Promise<DenSession> {
  try {
    return await signIn(den, input);
  } catch {
    // Bootstrap the missing member through the real invitation flow.
  }
  let markVerifiedWarning = "";
  const loginOptions = await denFetch(
    den,
    `/v1/auth/login-options?email=${encodeURIComponent(input.email)}`,
  );
  if (isRecord(loginOptions.body) && loginOptions.body.allowPublicSignup === false) {
    throw new Error(
      `Member bootstrap needs public signup, but this Den runs single-org mode with signup disabled. Start den-api with DEN_ORG_MODE=multi_org, use pnpm world up acme-demo, set DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP=true, or pre-provision ${input.email}.`,
    );
  }
  const invite = await denFetch(den, "/v1/invitations", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({ email: input.email, role: "member" }),
  });
  const inviteToken = stringField(invite.body, "inviteToken");
  if (!invite.response.ok || !inviteToken) {
    throw new Error(`Invitation failed: HTTP ${invite.response.status} ${preview(invite.body)}`);
  }
  const signUp = await denFetch(den, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: input.email, name: input.name ?? "Jordan Demo", password: input.password }),
  });
  if (!signUp.response.ok) {
    throw new Error(`Member sign-up failed: HTTP ${signUp.response.status} ${preview(signUp.body)}`);
  }
  // Best effort: verification is a convenience for dens that require it. If the
  // helper is absent or fails (its DB credentials drift), the sign-in below is
  // the real test — failing here would hide a member who can already sign in.
  try {
    doInternalMarkEmailVerified(input.markVerifiedCmd ?? "", input.email);
  } catch (error) {
    markVerifiedWarning = error instanceof Error ? error.message : String(error);
  }
  const member = await signIn(den, input).catch((signInError: unknown) => {
    const detail = signInError instanceof Error ? signInError.message : String(signInError);
    throw new Error(
      `${input.email} could not sign in after sign-up: ${detail}`
      + (markVerifiedWarning ? `\nEmail verification also failed first: ${markVerifiedWarning}` : ""),
    );
  });
  const accept = await denFetch(den, "/v1/orgs/invitations/accept", {
    method: "POST",
    headers: auth(member),
    body: JSON.stringify({ id: inviteToken }),
  });
  if (!accept.response.ok || !isRecord(accept.body) || accept.body.accepted !== true) {
    throw new Error(`Invitation accept failed: HTTP ${accept.response.status} ${preview(accept.body)}`);
  }
  return member;
}

function parseConnection(value: unknown): ConnectionFacts | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const name = stringField(value, "name");
  if (!id || !name) return null;
  return {
    id,
    name,
    connectedForMe: typeof value.connectedForMe === "boolean" ? value.connectedForMe : null,
    connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : null,
  };
}

function parseConnections(value: unknown): ConnectionFacts[] {
  if (!isRecord(value) || !Array.isArray(value.connections)) return [];
  return value.connections.flatMap((entry) => {
    const connection = parseConnection(entry);
    return connection ? [connection] : [];
  });
}

export async function createOrgConnection(
  admin: DenSession,
  input: { name: string; url: string; authType: string; credentialMode: string; access: { orgWide: boolean } },
): Promise<{ id: string; name: string }> {
  const result = await denFetch(admin, "/v1/mcp-connections", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify(input),
  });
  const connection = parseConnection(result.body);
  if (!result.response.ok || !connection) {
    throw new Error(`Connection create failed: HTTP ${result.response.status} ${preview(result.body)}`);
  }
  return { id: connection.id, name: connection.name };
}

export async function createNativeConnector(
  admin: DenSession,
  input: NativeConnectorInput,
): Promise<{ id: string; name: string }> {
  const result = await denFetch(admin, "/v1/mcp-connections", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({
      kind: "native_provider",
      nativeProviderKey: input.providerKey,
      name: input.name,
      oauthClient: {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        features: input.features,
      },
    }),
  });
  const connection = parseConnection(result.body);
  if (!result.response.ok || !connection) {
    throw new Error(`Native connector create failed: HTTP ${result.response.status} ${preview(result.body)}`);
  }
  return { id: connection.id, name: connection.name };
}

function needsFreshAuth(result: DenFetchResult): boolean {
  return result.response.status === 403 && isRecord(result.body) && result.body.error === "reauth";
}

async function retryOnceAfterFreshAuth(
  session: DenSession,
  operation: (active: DenSession) => Promise<DenFetchResult>,
): Promise<{ session: DenSession; result: DenFetchResult }> {
  let active = session;
  let result = await operation(active);
  if (needsFreshAuth(result)) {
    active = await freshSession(session);
    result = await operation(active);
  }
  return { session: active, result };
}

async function deleteConnectionWithSession(admin: DenSession, id: string): Promise<DenSession> {
  const { session, result } = await retryOnceAfterFreshAuth(admin, (active) => denFetch(active, `/v1/mcp-connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: auth(active),
  }));
  if (!result.response.ok) throw new Error(`Connection delete failed for ${id}: HTTP ${result.response.status} ${preview(result.body)}`);
  return session;
}

export async function deleteConnection(admin: DenSession, id: string): Promise<void> {
  await deleteConnectionWithSession(admin, id);
}

export async function deleteConnectionsNamed(admin: DenSession, prefix: string): Promise<void> {
  const listed = await retryOnceAfterFreshAuth(admin, (active) => denFetch(active, "/v1/mcp-connections?scope=manageable", {
    headers: auth(active),
  }));
  const result = listed.result;
  if (!result.response.ok) throw new Error(`Connection list failed: HTTP ${result.response.status} ${preview(result.body)}`);
  let active = listed.session;
  for (const connection of parseConnections(result.body)) {
    if (connection.name.startsWith(prefix)) active = await deleteConnectionWithSession(active, connection.id);
  }
}

export async function readUsableConnection(member: DenSession, id: string): Promise<ConnectionFacts | null> {
  const result = await denFetch(member, "/v1/mcp-connections?scope=usable", { headers: auth(member) });
  if (!result.response.ok) throw new Error(`Usable connection list failed: HTTP ${result.response.status} ${preview(result.body)}`);
  return parseConnections(result.body).find((connection) => connection.id === id) ?? null;
}

export async function provisionOrg(den: DenRef, input: ProvisionOrgInput): Promise<ProvisionedOrg> {
  const connectors = input.connectors ?? [];
  for (const connector of connectors) {
    if (connector !== "google-workspace") {
      throw new Error(`Unsupported provisionOrg connector: ${connector}`);
    }
  }

  const unique = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 12)}`;
  const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
  const email = `openwork-eval-admin-${unique}@example.test`;
  const name = `OpenWork Eval ${unique}`;
  const signUp = await denFetch(den, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name, password }),
  });
  if (!signUp.response.ok) {
    throw new Error(`Admin sign-up failed for ${email}: HTTP ${signUp.response.status} ${preview(signUp.body)}`);
  }

  const admin = await signIn(den, { email, password });
  const createOrg = await denFetch(den, "/v1/org", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({ name }),
  });
  const organization = isRecord(createOrg.body) && isRecord(createOrg.body.organization)
    ? createOrg.body.organization
    : null;
  const orgId = stringField(organization, "id");
  if (!createOrg.response.ok || !orgId) {
    throw new Error(`Organization create failed: HTTP ${createOrg.response.status} ${preview(createOrg.body)}`);
  }

  for (const memberEmail of input.members ?? []) {
    const member = await ensureMemberSession(den, admin, {
      email: memberEmail,
      password,
      name: "OpenWork Eval Member",
      markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
    });
    const orgs = await denFetch(den, "/v1/me/orgs", { headers: auth(member) });
    const memberships = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs : [];
    if (!orgs.response.ok) {
      throw new Error(`Organization membership list failed for ${memberEmail}: HTTP ${orgs.response.status} ${preview(orgs.body)}`);
    }
    if (memberships.some((entry) => stringField(entry, "id") === orgId)) continue;

    const invite = await denFetch(den, "/v1/invitations", {
      method: "POST",
      headers: auth(admin),
      body: JSON.stringify({ email: memberEmail, role: "member" }),
    });
    const inviteToken = stringField(invite.body, "inviteToken");
    if (!invite.response.ok || !inviteToken) {
      throw new Error(`Invitation failed for ${memberEmail}: HTTP ${invite.response.status} ${preview(invite.body)}`);
    }
    const accept = await denFetch(den, "/v1/orgs/invitations/accept", {
      method: "POST",
      headers: auth(member),
      body: JSON.stringify({ id: inviteToken }),
    });
    if (!accept.response.ok || !isRecord(accept.body) || accept.body.accepted !== true) {
      throw new Error(`Invitation accept failed for ${memberEmail}: HTTP ${accept.response.status} ${preview(accept.body)}`);
    }
  }

  for (const connector of connectors) {
    const configured = await denFetch(den, `/v1/oauth-providers/${connector}/client`, {
      method: "POST",
      headers: auth(admin),
      body: JSON.stringify({
        clientId: `openwork-eval-google-client-${unique}`,
        clientSecret: `openwork-eval-google-secret-${unique}`,
      }),
    });
    if (!configured.response.ok) {
      throw new Error(`Connector configuration failed for ${connector}: HTTP ${configured.response.status} ${preview(configured.body)}`);
    }
  }

  return { admin, orgId };
}

export async function createDesktopHandoffGrant(member: DenSession, desktopScheme = "openwork"): Promise<string> {
  const result = await denFetch(member, "/v1/auth/desktop-handoff", {
    method: "POST",
    headers: auth(member),
    body: JSON.stringify({ desktopScheme }),
  });
  const grant = stringField(result.body, "grant");
  if (!result.response.ok || !grant) {
    throw new Error(`Desktop handoff create failed: HTTP ${result.response.status} ${preview(result.body)}`);
  }
  return grant;
}
