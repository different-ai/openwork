import { denFetch, signIn } from "@openwork/behaviors";
import type { DenFetchResult, DenRef, DenSession } from "@openwork/behaviors";
import { eventually, needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { expect } from "vitest";

// Live lane: the production Den is attached and never owned by this spec. The
// timestamped user, organization, and invitations are launched onto it, so the
// spec owns their cleanup. den-api does not enable Better Auth's self-service
// account deletion endpoint, so the retained account is reported as residue.
// AGENTMAIL_API_KEY lives in Infisical. Invoke this spec with:
// infisical run -- pnpm evals:pr specs/prod-den-signup-invites.live.test.ts

const AGENTMAIL_API_URL = "https://api.agentmail.to/v0";
const MAX_AGENTMAIL_INBOXES = 2;
const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_LIVE"],
  env: ["OPENWORK_EVAL_LIVE_DEN_API_URL", "AGENTMAIL_API_KEY"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `production Den signup and invitations skipped — needs: ${missingRequirements.join(", ")}`
  : "production Den supports verified signup, delivered organization invitations, and owned cleanup";

interface LiveIdentity {
  owner: string;
  invitees: [string, string];
  neverInvited: string;
}

interface AgentMailInbox {
  inboxId: string;
  email: string;
}

interface AgentMailMessageSummary {
  messageId: string;
  subject: string;
}

interface AgentMailMessage extends AgentMailMessageSummary {
  to: string[];
  text: string;
  html: string;
}

interface OrganizationSummary {
  id: string;
  name: string;
}

interface OrganizationList {
  activeOrgId: string | null;
  activeOrgSlug: string | null;
  orgs: OrganizationSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return isRecord(field) ? field : null;
}

function stringArrayField(value: unknown, key: string): string[] | null {
  if (!isRecord(value) || !Array.isArray(value[key])) return null;
  const fields: string[] = [];
  for (const field of value[key]) {
    if (typeof field !== "string") return null;
    fields.push(field);
  }
  return fields;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Unreachable after needs(): ${name} is missing.`);
  return value;
}

async function agentMailFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<DenFetchResult> {
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

async function createAgentMailInbox(apiKey: string, username: string): Promise<AgentMailInbox> {
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

async function deleteAgentMailInbox(apiKey: string, inbox: AgentMailInbox): Promise<void> {
  const result = await agentMailFetch(apiKey, `/inboxes/${encodeURIComponent(inbox.inboxId)}`, { method: "DELETE" });
  if (!result.response.ok && result.response.status !== 404) {
    throw responseFailure(`AgentMail inbox cleanup failed for ${inbox.email}`, result);
  }
}

async function listAgentMailMessages(
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

async function getAgentMailMessage(
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

async function waitForAgentMailMessage(
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

function verificationCode(message: AgentMailMessage): string {
  const match = `${message.subject}\n${message.text}\n${message.html}`.match(/\b(\d{6})\b/);
  const code = match?.[1];
  if (!code) throw new Error(`Verification email ${message.messageId} contained no six-digit code.`);
  return code;
}

function plusAddress(email: string, tag: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) throw new Error(`Cannot plus-address invalid email ${email}.`);
  return `${email.slice(0, at)}+${tag}@${email.slice(at + 1)}`;
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function responseFailure(label: string, result: DenFetchResult): Error {
  return new Error(`${label}: HTTP ${result.response.status} ${result.text.slice(0, 1_000)}`);
}

function parseOrganizationList(result: DenFetchResult, label: string): OrganizationList {
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

async function listOrganizations(session: DenSession, label: string): Promise<OrganizationList> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: auth(session) });
  return parseOrganizationList(result, label);
}

async function createOrganization(session: DenSession, name: string): Promise<string> {
  const result = await denFetch(session, "/v1/org", {
    method: "POST",
    headers: auth(session),
    body: JSON.stringify({ name }),
  });
  const id = stringField(recordField(result.body, "organization"), "id");
  if (result.response.status !== 201 || !id) throw responseFailure("Organization creation failed", result);
  return id;
}

async function invite(session: DenSession, email: string): Promise<void> {
  const result = await denFetch(session, "/v1/invitations", {
    method: "POST",
    headers: auth(session),
    body: JSON.stringify({ email, role: "member" }),
  });
  if (!result.response.ok) throw responseFailure(`Invitation failed for ${email}`, result);
}

function listedEmails(body: unknown, key: "invitations" | "members"): string[] {
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

async function organizationEmails(session: DenSession): Promise<{ invitations: string[]; members: string[] }> {
  const result = await denFetch(session, "/v1/org", { headers: auth(session) });
  if (result.response.status !== 200) throw responseFailure("Organization invite/member listing failed", result);
  return {
    invitations: listedEmails(result.body, "invitations"),
    members: listedEmails(result.body, "members"),
  };
}

async function deleteCreatedOrganization(session: DenSession, organizationId: string): Promise<void> {
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

test(title, { timeout: 240_000 }, async ({ evidence }) => {
  needs(requirements);
  const apiUrl = requiredEnv("OPENWORK_EVAL_LIVE_DEN_API_URL").replace(/\/+$/, "");
  const agentMailApiKey = requiredEnv("AGENTMAIL_API_KEY");
  const webUrl = apiUrl === "https://api.openworklabs.com" ? "https://app.openworklabs.com" : apiUrl;
  const den: DenRef = { apiUrl, webUrl };
  const runStartedAt = new Date().toISOString();
  const timestamp = runStartedAt.replace(/\D/g, "");
  const runPrefix = `openwork-live-${timestamp}`;
  const password = `ProdLive-${timestamp}!`;
  const organizationName = `Prod Live ${timestamp}`;
  const agentMailInboxes: AgentMailInbox[] = [];
  const agentMailDeleted: string[] = [];
  const agentMailResidue: string[] = [];
  let identity: LiveIdentity | null = null;
  let session: DenSession | null = null;
  let organizationId: string | null = null;
  let organizationDeleted = false;
  let accountCreated = false;
  let scenarioError: unknown = null;
  let cleanupError: unknown = null;

  async function provisionAgentMailInbox(role: string): Promise<AgentMailInbox> {
    if (agentMailInboxes.length >= MAX_AGENTMAIL_INBOXES) {
      throw new Error(`AgentMail inbox cap of ${MAX_AGENTMAIL_INBOXES} reached for this live run.`);
    }
    const inbox = await createAgentMailInbox(agentMailApiKey, `${runPrefix}-${role}`);
    agentMailInboxes.push(inbox);
    return inbox;
  }

  try {
    const ownerInbox = await provisionAgentMailInbox("owner");
    const inviteeM1Inbox = await provisionAgentMailInbox("m1");
    const at = ownerInbox.email.lastIndexOf("@");
    if (at < 1 || at === ownerInbox.email.length - 1) {
      throw new Error(`AgentMail created an invalid owner address: ${ownerInbox.email}`);
    }
    const createdIdentity: LiveIdentity = {
      owner: ownerInbox.email,
      invitees: [inviteeM1Inbox.email, plusAddress(inviteeM1Inbox.email, "m2")],
      neverInvited: `${runPrefix}-never-invited@${ownerInbox.email.slice(at + 1)}`,
    };
    identity = createdIdentity;

    const signUp = await denFetch(den, "/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: createdIdentity.owner, name: `Prod Live ${timestamp}`, password }),
    });
    expect(signUp.response.ok, `Sign-up failed: HTTP ${signUp.response.status} ${signUp.text.slice(0, 1_000)}`).toBe(true);
    accountCreated = true;

    const verificationMessage = await waitForAgentMailMessage(
      agentMailApiKey,
      ownerInbox,
      runStartedAt,
      `OpenWork verification email in ${ownerInbox.email}`,
      (message) => message.subject.toLowerCase().includes("openwork verification code"),
    );
    const verified = await denFetch(den, "/api/auth/email-otp/verify-email", {
      method: "POST",
      body: JSON.stringify({ email: createdIdentity.owner, otp: verificationCode(verificationMessage) }),
    });
    expect(
      verified.response.ok,
      `Email verification failed: HTTP ${verified.response.status} ${verified.text.slice(0, 1_000)}`,
    ).toBe(true);

    session = await signIn(den, { email: createdIdentity.owner, password });
    const baseline = await listOrganizations(session, "Authenticated baseline organization list failed");
    const wrongPassword = await denFetch(den, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: createdIdentity.owner, password: `${password}-wrong` }),
    });
    expect(wrongPassword.response.ok, `Wrong password unexpectedly returned HTTP ${wrongPassword.response.status}`).toBe(false);
    expect(wrongPassword.response.status).toBeGreaterThanOrEqual(400);
    evidence.recordAssertionEvidence(
      "C1: fresh production signup receives verification, verifies, and authenticates while a wrong password is rejected",
      `${createdIdentity.owner} received AgentMail message ${verificationMessage.messageId}; OTP verification and GET /v1/me/orgs succeeded, while the wrong-password sign-in returned HTTP ${wrongPassword.response.status}.`,
      true,
    );

    organizationId = await createOrganization(session, organizationName);
    await invite(session, createdIdentity.invitees[0]);
    await invite(session, createdIdentity.invitees[1]);
    const invitationMessage = await waitForAgentMailMessage(
      agentMailApiKey,
      inviteeM1Inbox,
      runStartedAt,
      `OpenWork organization invitation in ${inviteeM1Inbox.email}`,
      (message) => message.subject.includes(organizationName)
        && message.subject.toLowerCase().includes("invited")
        && message.to.some((recipient) => recipient.toLowerCase().includes(createdIdentity.invitees[0].toLowerCase())),
    );
    expect(invitationMessage.subject).toContain(organizationName);
    expect(
      invitationMessage.to.some((recipient) => recipient.toLowerCase().includes(createdIdentity.invitees[0].toLowerCase())),
    ).toBe(true);

    const organizationList = await listOrganizations(session, "Post-creation organization list failed");
    expect(organizationList.orgs).toEqual([{ id: organizationId, name: organizationName }]);
    const emails = await organizationEmails(session);
    expect(emails.invitations).toEqual([...createdIdentity.invitees].sort());
    expect(emails.members).toEqual([createdIdentity.owner, ...createdIdentity.invitees].sort());
    expect(emails.invitations).not.toContain(createdIdentity.neverInvited);
    expect(emails.members).not.toContain(createdIdentity.neverInvited);
    evidence.recordAssertionEvidence(
      "C2: the first invitation is delivered and the new organization contains exactly both invitations while excluding a never-invited address",
      `AgentMail delivered message ${invitationMessage.messageId} to ${createdIdentity.invitees[0]}; ${organizationName}'s invitation and member listings contain ${createdIdentity.invitees.join(" and ")} and omit ${createdIdentity.neverInvited}.`,
      true,
    );

    await deleteCreatedOrganization(session, organizationId);
    organizationDeleted = true;
    session = await signIn(den, { email: createdIdentity.owner, password });
    const afterCleanup = await listOrganizations(session, "Post-cleanup organization list failed");
    expect(afterCleanup).toEqual(baseline);
    organizationId = null;
    evidence.recordAssertionEvidence(
      "C3: owned production organization data is deleted",
      `DELETE /v1/org removed ${organizationName}; the normalized organization list returned to its exact pre-creation baseline. den-api does not enable its self-service account deletion endpoint.`,
      true,
    );
  } catch (error) {
    scenarioError = error;
  } finally {
    if (organizationId && session) {
      try {
        await deleteCreatedOrganization(session, organizationId);
        organizationDeleted = true;
        organizationId = null;
      } catch (error) {
        cleanupError = error;
      }
    }
    for (const inbox of [...agentMailInboxes].reverse()) {
      try {
        await deleteAgentMailInbox(agentMailApiKey, inbox);
        agentMailDeleted.push(`${inbox.email}(${inbox.inboxId})`);
      } catch (error) {
        agentMailResidue.push(`${inbox.email}(${inbox.inboxId}): ${errorMessage(error)}`);
      }
    }
    console.info(
      `[live-lane] owner=${identity?.owner ?? "not-created"} invitees=${identity?.invitees.join(",") ?? "not-created"} neverInvited=${identity?.neverInvited ?? "not-created"} org=${organizationName} orgDeleted=${String(organizationDeleted)} accountCreated=${String(accountCreated)} accountDeletion=self-service-disabled agentMailCreated=${agentMailInboxes.map((inbox) => `${inbox.email}(${inbox.inboxId})`).join(",") || "none"} agentMailDeleted=${agentMailDeleted.join(",") || "none"} agentMailResidue=${agentMailResidue.join(" | ") || "none"}`,
    );
  }

  if (scenarioError) {
    if (cleanupError) {
      throw new Error(`${errorMessage(scenarioError)}; cleanup also failed: ${errorMessage(cleanupError)}`);
    }
    throw scenarioError;
  }
  if (cleanupError) throw cleanupError;
});
