import { denFetch, signIn } from "@openwork/behaviors";
import type { DenRef, DenSession } from "@openwork/behaviors";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { expect } from "vitest";
import { auth, createAgentMailInbox, createOrganization, deleteAgentMailInbox, deleteCreatedOrganization, errorMessage, invite, listOrganizations, organizationEmails, plusAddress, requiredEnv, verificationCode, waitForAgentMailMessage } from "../worlds/live-den-api.ts";
import type { AgentMailInbox } from "../worlds/live-den-api.ts";

// Live lane: the production Den is attached and never owned by this spec. The
// timestamped user, organization, and invitations are launched onto it, so the
// spec owns their cleanup. den-api does not enable Better Auth's self-service
// account deletion endpoint, so the retained account is reported as residue.
// AGENTMAIL_API_KEY lives in Infisical. Invoke this spec with:
// infisical run -- pnpm evals:pr specs/prod-den-signup-invites.live.test.ts


const MAX_AGENTMAIL_INBOXES = 2;
const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_LIVE"],
  env: ["OPENWORK_EVAL_LIVE_DEN_API_URL", "AGENTMAIL_API_KEY"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `.live production Den signup and invitations skipped — needs: ${missingRequirements.join(", ")}`
  : ".live production Den supports verified signup, delivered organization invitations, and owned cleanup";

interface LiveIdentity {
  owner: string;
  invitees: [string, string];
  neverInvited: string;
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
  if (agentMailResidue.length > 0) throw new Error(`AgentMail cleanup failed: ${agentMailResidue.join("; ")}`);
});
