import { denFetch, signIn } from "@openwork/behaviors";
import type { DenFetchResult, DenSession } from "@openwork/behaviors";
const AGENTMAIL_API_URL = "https://api.agentmail.to/v0";
export interface AgentMailInbox {
  inboxId: string;
  email: string;
}

export interface AgentMailMessageSummary {
  messageId: string;
  subject: string;
}

export interface AgentMailMessage extends AgentMailMessageSummary {
  to: string[];
  text: string;
  html: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
}

export interface OrganizationList {
  activeOrgId: string | null;
  activeOrgSlug: string | null;
  orgs: OrganizationSummary[];
}

async function eventually<T>(read: () => Promise<T>, options: { within: number; intervalMs: number; label: string; until: (value: T) => boolean }): Promise<T> {
  const deadline = Date.now() + options.within;
  do {
    const value = await read();
    if (options.until(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${options.label}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

export function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return isRecord(field) ? field : null;
}

export function stringArrayField(value: unknown, key: string): string[] | null {
  if (!isRecord(value) || !Array.isArray(value[key])) return null;
  const fields: string[] = [];
  for (const field of value[key]) {
    if (typeof field !== "string") return null;
    fields.push(field);
  }
  return fields;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Unreachable after needs(): ${name} is missing.`);
  return value;
}

export async function agentMailFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<DenFetchResult> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${AGENTMAIL_API_URL}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(30_000),
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

export async function createAgentMailInbox(apiKey: string, username: string): Promise<AgentMailInbox> {
  const result = await agentMailFetch(apiKey, "/inboxes", {
    method: "POST",
    body: JSON.stringify({
      username,
      display_name: username,
      client_id: username,
    }),
  });
  const inboxId = stringField(result.body, "inbox_id");
  const email = stringField(result.body, "email");
  if (result.response.status !== 200 || !inboxId || !email) {
    throw responseFailure(`AgentMail inbox creation failed for ${username}`, result);
  }
  if (!email.toLowerCase().startsWith(`${username.toLowerCase()}@`)) {
    throw new Error(`AgentMail created ${email} instead of the requested timestamped username ${username}.`);
  }
  return { inboxId, email };
}

export async function deleteAgentMailInbox(apiKey: string, inbox: AgentMailInbox): Promise<void> {
  const result = await agentMailFetch(apiKey, `/inboxes/${encodeURIComponent(inbox.inboxId)}`, { method: "DELETE" });
  if (!result.response.ok && result.response.status !== 404) {
    throw responseFailure(`AgentMail inbox cleanup failed for ${inbox.email}`, result);
  }
}

export async function listAgentMailMessages(
  apiKey: string,
  inbox: AgentMailInbox,
  after: string,
): Promise<AgentMailMessageSummary[]> {
  const query = new URLSearchParams({
    limit: "20",
    after,
    include_unauthenticated: "true",
  });
  const result = await agentMailFetch(
    apiKey,
    `/inboxes/${encodeURIComponent(inbox.inboxId)}/messages?${query.toString()}`,
  );
  if (!result.response.ok || !isRecord(result.body) || !Array.isArray(result.body.messages)) {
    throw responseFailure(`AgentMail message listing failed for ${inbox.email}`, result);
  }

  const messages: AgentMailMessageSummary[] = [];
  for (const value of result.body.messages) {
    const messageId = stringField(value, "message_id");
    if (!messageId) {
      throw new Error(`AgentMail returned a message without message_id: ${JSON.stringify(value).slice(0, 500)}`);
    }
    messages.push({ messageId, subject: stringField(value, "subject") ?? "" });
  }
  return messages;
}

export async function getAgentMailMessage(
  apiKey: string,
  inbox: AgentMailInbox,
  summary: AgentMailMessageSummary,
): Promise<AgentMailMessage> {
  const result = await agentMailFetch(
    apiKey,
    `/inboxes/${encodeURIComponent(inbox.inboxId)}/messages/${encodeURIComponent(summary.messageId)}`,
  );
  const messageId = stringField(result.body, "message_id");
  const to = stringArrayField(result.body, "to");
  if (!result.response.ok || !messageId || !to) {
    throw responseFailure(`AgentMail message retrieval failed for ${summary.messageId}`, result);
  }
  return {
    messageId,
    subject: stringField(result.body, "subject") ?? summary.subject,
    to,
    text: stringField(result.body, "text") ?? "",
    html: stringField(result.body, "html") ?? "",
  };
}

export async function waitForAgentMailMessage(
  apiKey: string,
  inbox: AgentMailInbox,
  after: string,
  label: string,
  messageMatches: (message: AgentMailMessage) => boolean,
): Promise<AgentMailMessage> {
  const message = await eventually(async () => {
    const messages = await listAgentMailMessages(apiKey, inbox, after);
    for (const summary of messages) {
      const candidate = await getAgentMailMessage(apiKey, inbox, summary);
      if (messageMatches(candidate)) return candidate;
    }
    return null;
  }, {
    within: 60_000,
    intervalMs: 2_000,
    label,
    until: (candidate) => candidate !== null,
  });
  if (!message) throw new Error(`Unreachable after eventually(): ${label} was not delivered.`);
  return message;
}

export function verificationCode(message: AgentMailMessage): string {
  const match = `${message.subject}\n${message.text}\n${message.html}`.match(/\b(\d{6})\b/);
  const code = match?.[1];
  if (!code) throw new Error(`Verification email ${message.messageId} contained no six-digit code.`);
  return code;
}

export function plusAddress(email: string, tag: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) throw new Error(`Cannot plus-address invalid email ${email}.`);
  return `${email.slice(0, at)}+${tag}@${email.slice(at + 1)}`;
}

export function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

export function responseFailure(label: string, result: DenFetchResult): Error {
  return new Error(`${label}: HTTP ${result.response.status} ${result.text.slice(0, 1_000)}`);
}

export function parseOrganizationList(result: DenFetchResult, label: string): OrganizationList {
  if (result.response.status !== 200 || !isRecord(result.body) || !Array.isArray(result.body.orgs)) {
    throw responseFailure(label, result);
  }

  const orgs: OrganizationSummary[] = [];
  for (const value of result.body.orgs) {
    const id = stringField(value, "id");
    const name = stringField(value, "name");
    if (!id || !name) throw new Error(`${label}: malformed organization ${JSON.stringify(value).slice(0, 500)}`);
    orgs.push({ id, name });
  }

  const activeOrgId = result.body.activeOrgId;
  const activeOrgSlug = result.body.activeOrgSlug;
  if (activeOrgId !== null && typeof activeOrgId !== "string") {
    throw new Error(`${label}: activeOrgId was neither a string nor null.`);
  }
  if (activeOrgSlug !== null && typeof activeOrgSlug !== "string") {
    throw new Error(`${label}: activeOrgSlug was neither a string nor null.`);
  }

  return {
    activeOrgId,
    activeOrgSlug,
    orgs: orgs.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function listOrganizations(session: DenSession, label: string): Promise<OrganizationList> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: auth(session) });
  return parseOrganizationList(result, label);
}

export async function createOrganization(session: DenSession, name: string): Promise<string> {
  const result = await denFetch(session, "/v1/org", {
    method: "POST",
    headers: auth(session),
    body: JSON.stringify({ name }),
  });
  const id = stringField(recordField(result.body, "organization"), "id");
  if (result.response.status !== 201 || !id) throw responseFailure("Organization creation failed", result);
  return id;
}

export async function invite(session: DenSession, email: string): Promise<void> {
  const result = await denFetch(session, "/v1/invitations", {
    method: "POST",
    headers: auth(session),
    body: JSON.stringify({ email, role: "member" }),
  });
  if (!result.response.ok) throw responseFailure(`Invitation failed for ${email}`, result);
}

export function listedEmails(body: unknown, key: "invitations" | "members"): string[] {
  if (!isRecord(body) || !Array.isArray(body[key])) {
    throw new Error(`Organization listing had no ${key} array: ${JSON.stringify(body).slice(0, 500)}`);
  }
  const emails: string[] = [];
  for (const value of body[key]) {
    const email = key === "invitations"
      ? stringField(value, "email")
      : stringField(recordField(value, "user"), "email");
    if (!email) throw new Error(`Organization ${key} entry had no email: ${JSON.stringify(value).slice(0, 500)}`);
    emails.push(email);
  }
  return emails.sort();
}

export async function organizationEmails(session: DenSession): Promise<{ invitations: string[]; members: string[] }> {
  const result = await denFetch(session, "/v1/org", { headers: auth(session) });
  if (result.response.status !== 200) throw responseFailure("Organization invite/member listing failed", result);
  return {
    invitations: listedEmails(result.body, "invitations"),
    members: listedEmails(result.body, "members"),
  };
}

export async function deleteCreatedOrganization(session: DenSession, organizationId: string): Promise<void> {
  const active = await signIn(session, { email: session.email, password: session.password });
  const selected = await denFetch(active, "/v1/me/active-organization", {
    method: "POST",
    headers: auth(active),
    body: JSON.stringify({ organizationId }),
  });
  if (selected.response.status === 404) return;
  if (!selected.response.ok) throw responseFailure("Organization cleanup selection failed", selected);

  const deleted = await denFetch(active, "/v1/org", { method: "DELETE", headers: auth(active) });
  if (!deleted.response.ok && deleted.response.status !== 404) {
    throw responseFailure("Organization cleanup failed", deleted);
  }
}

