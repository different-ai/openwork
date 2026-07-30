import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type DenRef = { apiUrl: string; webUrl: string };
export type DenSession = DenRef & { token: string; email: string };
export type ConnectionFacts = { id: string; name: string; connectedForMe: boolean | null; connectedAt: string | null };
export type DenFetchResult = { response: Response; body: unknown; text: string };

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

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
  const response = await fetch(`${trimTrailingSlashes(den.apiUrl)}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.trim() ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

export async function signIn(den: DenRef, credentials: { email: string; password: string }): Promise<DenSession> {
  const result = await denFetch(den, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
  const token = stringField(result.body, "token");
  if (!result.response.ok || !token) {
    throw new Error(`Sign-in failed for ${credentials.email}: HTTP ${result.response.status} ${preview(result.body)}`);
  }
  return { ...den, token, email: credentials.email };
}

export function doInternalMarkEmailVerified(command: string, email: string): void {
  if (!command.trim()) throw new Error("OPENWORK_EVAL_MARK_VERIFIED_CMD is required to verify a newly-created member.");
  execSync(command.replaceAll("{email}", email), { cwd: REPO_ROOT, stdio: "ignore" });
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
  doInternalMarkEmailVerified(input.markVerifiedCmd ?? "", input.email);
  const member = await signIn(den, input);
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

export async function deleteConnection(admin: DenSession, id: string): Promise<void> {
  const result = await denFetch(admin, `/v1/mcp-connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: auth(admin),
  });
  if (!result.response.ok) throw new Error(`Connection delete failed for ${id}: HTTP ${result.response.status} ${preview(result.body)}`);
}

export async function deleteConnectionsNamed(admin: DenSession, prefix: string): Promise<void> {
  const result = await denFetch(admin, "/v1/mcp-connections?scope=manageable", { headers: auth(admin) });
  if (!result.response.ok) throw new Error(`Connection list failed: HTTP ${result.response.status} ${preview(result.body)}`);
  for (const connection of parseConnections(result.body)) {
    if (connection.name.startsWith(prefix)) await deleteConnection(admin, connection.id);
  }
}

export async function readUsableConnection(member: DenSession, id: string): Promise<ConnectionFacts | null> {
  const result = await denFetch(member, "/v1/mcp-connections?scope=usable", { headers: auth(member) });
  if (!result.response.ok) throw new Error(`Usable connection list failed: HTTP ${result.response.status} ${preview(result.body)}`);
  return parseConnections(result.body).find((connection) => connection.id === id) ?? null;
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
