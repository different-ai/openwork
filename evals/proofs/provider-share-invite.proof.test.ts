import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { membersFor, record, rows } from "../worlds/org-invite.ts";
import { providerShareInvite } from "../worlds/provider-share-invite.ts";

const test = spec.world(providerShareInvite, {
  timeout: 720_000,
  resources: { surfaces: ["appWeb", "web"], services: ["den"] },
});
const WITHIN = 60_000;

test("an owner shares a device key with their organization, cancels safely first, and a newly invited teammate joins without receiving that key", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const member = user.on(world.memberApp);
  const memberProbe = probe.on(world.memberApp);
  const invitee = user.on(world.inviteWeb);
  let providerId = "";
  const providers = async () => {
    const response = await world.providers();
    expect(response.response.ok, response.text).toBe(true);
    return { entries: rows(record(response.body).inferenceProviders), text: response.text };
  };
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  await step("before: the owner's connected OpenAI key is only on this device", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    if (await probe.has("Could not load the provider list or OpenCode configuration.")) {
      const status = await world.localRequest("/experimental/engine-v2-preview/status");
      await user.screenshot();
      throw new Error(`Cold provider list unavailable; engine status ${JSON.stringify(status.body)}`);
    }
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, "OpenAI");
    await user.click({ role: "button", label: /^OpenAI/ });
    if (await probe.has("Choose how you'd like to connect.")) {
      await user.click({ role: "button", label: /API key/i });
    }
    await user.type({ label: "API key" }, world.key, { sensitive: true });
    await user.click({ role: "button", label: "Save key" });
    await user.notSee({ role: "button", label: "Save key" }, { timeoutMs: WITHIN });
    await user.notSee({ testId: "share-provider-openai" });
    const before = await providers();
    expect(before.entries).toHaveLength(0);
    evidence.recordAssertionEvidence("The key is connected locally and nothing is shared", `device row=OpenAI; organization providers=${before.entries.length}`, before.entries.length === 0);
    await user.screenshot();
  });

  await step("the desktop user finishes cloud sign-in with a one-time code; the key stays personal", async () => {
    await user.navigate(`${world.app.webUrl}/settings/cloud-account`);
    await user.see({ role: "button", label: "Paste sign-in code" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Paste sign-in code" });
    // A single-use, five-minute handoff code, consumed by this click.
    await user.type({ role: "textbox", label: "Sign-in link or one-time code" }, await world.ownerGrant());
    await user.click({ role: "button", label: "Finish sign-in" });
    await user.notSee({ role: "button", label: "Finish sign-in" }, { timeoutMs: WITHIN });
    await user.navigate(world.settingsUrl);
    await user.see({ testId: "share-provider-openai" }, { timeoutMs: WITHIN });
    const before = await providers();
    expect(before.entries).toHaveLength(0);
    evidence.recordAssertionEvidence("Signing in preserves the local key without uploading it", `one-time code accepted; sharing now offered; organization providers=${before.entries.length}`, before.entries.length === 0);
    await user.screenshot();
  });

  await step("before: a plain member's desktop shows who manages AI providers, with nothing to click", async () => {
    await member.navigate(world.memberSettingsUrl);
    await member.see({ testId: "organization-share-empty" }, { timeoutMs: WITHIN });
    await member.see({ text: `Share Owner manages AI providers for ${world.organizationName}.` });
    await member.notSee({ role: "button", label: "Add a provider" });
    await member.notSee({ role: "button", label: /^Open in Den/ });
    const locked = (await memberProbe.dom('[data-testid="organization-share-empty"][data-state="locked"]')).elements.length === 1;
    expect(locked).toBe(true);
    evidence.recordAssertionEvidence("A member sees a lock naming the owner, and no action they cannot complete", `locked=${locked}; Add a provider and Open in Den absent`, locked);
    await member.screenshot();
  });

  await step("canceling the share confirmation sends no key to the organization", async () => {
    await user.click({ testId: "share-provider-openai" });
    await user.see({ testId: "share-provider-dialog" });
    await user.see({ role: "heading", label: `Share OpenAI with ${world.organizationName}?` });
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
    await user.notSee({ testId: "share-provider-dialog" });
    const after = await providers();
    expect(after.entries).toHaveLength(0);
    evidence.recordAssertionEvidence("Cancel leaves the provider only on this device", `organization providers after Cancel=${after.entries.length}`, after.entries.length === 0);
    await user.screenshot();
  });

  await step("after: confirming shares OpenAI with this organization, not its raw key", async () => {
    await user.click({ testId: "share-provider-openai" });
    await user.click({ testId: "share-provider-confirm" });
    try {
      await probe.eventually(() => probe.dom('[data-testid="share-provider-dialog"]'), {
        within: WITHIN, label: "the confirmed share finishes", until: (dom) => dom.elements.length === 0,
      });
      await user.notSee({ testId: "share-provider-dialog" });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; share responses=${JSON.stringify(world.shareResponses())}; diagnostics=${JSON.stringify(await world.shareDiagnostics())}`);
    }
    const after = await probe.eventually(providers, { within: WITHIN, label: "one organization provider", until: (value) => value.entries.length === 1 });
    providerId = String(after.entries[0]?.id);
    expect(providerId).toMatch(/^ipr_/);
    expect(after.text).not.toContain(world.key);
    await user.notSee({ testId: "share-provider-openai" });
    evidence.recordAssertionEvidence("The organization now owns one provider without returning the device key", `providers=${after.entries.length}; provider id has organization prefix=${providerId.startsWith("ipr_")}; raw key in response=${after.text.includes(world.key)}`, after.entries.length === 1 && !after.text.includes(world.key));
    await user.screenshot();
  });

  await step("the owner invites a new teammate through Members and the local mailbox captures the invitation", async () => {
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/members`);
    await owner.see({ role: "button", label: "Add member" }, { timeoutMs: WITHIN });
    await owner.click({ role: "button", label: "Add member" });
    await owner.type({ testId: "invite-email" }, world.person.email);
    await owner.see({ testId: "invite-model-access" }, { timeoutMs: WITHIN });
    await owner.see({ text: "Shared models" });
    await owner.see({ text: "Shared key added" }, { timeoutMs: WITHIN });
    await owner.screenshot();
    await owner.click({ role: "button", label: "Send invite" });
    await owner.see({ text: world.person.email }, { timeoutMs: WITHIN });
    const emails = await world.witnesses.emails("organizationInvite", world.person.email);
    expect(emails).toHaveLength(1);
    evidence.recordAssertionEvidence("The UI invitation produced one captured local email, not a real delivery", `invitation emails=${emails.length}; recipient=${world.person.email}`, emails.length === 1);
    await owner.screenshot();
  });

  await step("the new teammate signs up from the invitation and joins the right organization", async () => {
    await invitee.navigate(await world.inviteLink(world.person.email));
    await invitee.see({ text: world.person.email }, { timeoutMs: WITHIN });
    await invitee.type({ role: "textbox", label: /^name$/i }, world.person.name);
    await invitee.type({ role: "textbox", label: /^password$/i }, world.person.password, { sensitive: true });
    await invitee.click({ role: "button", label: "Create account" });
    await invitee.see({ role: "button", label: `Join ${world.organizationName}` }, { timeoutMs: WITHIN });
    await invitee.screenshot();
    await invitee.click({ role: "button", label: `Join ${world.organizationName}` });
    const organization = await probe.eventually(() => world.witnesses.org(world.organizationId), { within: WITHIN, label: "new teammate joined", until: (org) => membersFor(org, world.person.email).length === 1 });
    expect(membersFor(organization, world.person.email)[0]?.role).toBe("member");
    const session = await world.sessionFor();
    const catalog = await probe.api(session, "/v1/inference-providers", { headers: { "x-openwork-org-id": world.organizationId } });
    expect(catalog.response.ok, catalog.text).toBe(true);
    expect(catalog.text).toContain(providerId);
    expect(catalog.text).not.toContain(world.key);
    evidence.recordAssertionEvidence("The invited account joins once and receives the organization provider, never the owner's key", `memberships=${membersFor(organization, world.person.email).length}; role=member; catalog HTTP ${catalog.response.status}; shared provider present=${catalog.text.includes(providerId)}; raw key present=${catalog.text.includes(world.key)}`, membersFor(organization, world.person.email).length === 1 && catalog.text.includes(providerId) && !catalog.text.includes(world.key));
    await invitee.screenshot();
  });

  await step("after: the plain member's desktop receives the shared OpenAI from the organization, with no way to re-share it", async () => {
    await member.reload();
    const organizationRows = await memberProbe.eventually(() => memberProbe.dom('[data-provider-scope="organization"]'), {
      within: WITHIN, label: "the shared provider reaches the member", until: (dom) => dom.elements.some((row) => row.text.includes("OpenAI")),
    });
    await member.notSee({ testId: "organization-share-empty" });
    const offers = (await memberProbe.dom('[data-testid^="share-provider-"]')).elements.length;
    expect(offers).toBe(0);
    evidence.recordAssertionEvidence("The member gets the organization's OpenAI without the owner's key and cannot share", `organization rows=${organizationRows.elements.length}, one names OpenAI; share actions=${offers}`, offers === 0);
    await member.screenshot();
  });

  await step("a different organization cannot see the shared provider, and a plain member cannot offer a device key", async () => {
    await owner.reload();
    await owner.see({ text: world.person.email }, { timeoutMs: WITHIN });
    const other = await probe.api(world.otherOwner, "/v1/inference-providers", { headers: { "x-openwork-org-id": world.otherOrganizationId } });
    expect(other.response.ok).toBe(true);
    expect(other.text).not.toContain(providerId);
    const featureOff = await probe.api(world.otherOwner, "/v1/inference-providers/device-share-options?providerIds=openai", { headers: { "x-openwork-org-id": world.otherOrganizationId } });
    expect(featureOff.response.status).toBe(404);
    expect(featureOff.text).toContain("feature_disabled");
    const member = await probe.api(world.member, "/v1/inference-providers/device-share-options?providerIds=openai", { headers: { "x-openwork-org-id": world.organizationId } });
    const denied = member.response.status === 403 || (member.response.ok && record(member.body).canShare === false);
    expect(denied).toBe(true);
    expect(member.text).not.toContain(world.key);
    evidence.recordAssertionEvidence("Sharing remains organization-scoped and management-only", `different organization HTTP ${other.response.status}, shared provider absent; member options HTTP ${member.response.status}, sharing refused=${denied}; raw key absent`, !other.text.includes(providerId) && denied && !member.text.includes(world.key));
    await owner.screenshot();
  });
});
