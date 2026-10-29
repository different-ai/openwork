import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { workbotSharing } from "../worlds/workbot-sharing.ts";
import { invitationWitnesses, orgInviteLink } from "../worlds/org-invite.ts";

const test = spec.world(workbotSharing, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });
const invitationTest = spec.world(orgInviteLink, { timeout: 420_000, resources: { surfaces: ["web"], services: ["den"] } });

const removed = 'button[aria-label="Share Workbot"], input[aria-label="Workbot link"]';

test("a member sees no link-only sharing or replacement invitation placeholder", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  for (const sharing of ["on", "off"]) {
    await step(`after: a member has no share entry with legacy sharing ${sharing}`, async () => {
      await user.navigate(`${world.url}?sharing=${sharing}`);
      await user.see({ role: "textbox", label: "Message Workbot" });
      await user.type({ role: "textbox", label: "Message Workbot" }, "Keep this draft");
      await user.notSee({ role: "button", label: "Share Workbot" });
      await user.notSee({ role: "button", label: "Copy Workbot link" });
      await user.notSee({ text: "Copied Workbot link" });
      await user.notSee({ text: "A link doesn't grant access. Ask your team admin to invite coworkers." });
      await user.notSee({ text: "Sharing is off. A platform admin can turn it on." });
      await user.notSee({ role: "button", label: "Invite coworkers" });
      const controls = await probe.dom(removed);
      expect(controls.elements).toHaveLength(0);
      expect(world.writes()).toEqual([]);
      evidence.recordAssertionEvidence("The conversation has no copy-only or locked share entry", `share controls=${controls.elements.length}; writes=${world.writes().length}; draft retained`, controls.elements.length === 0 && world.writes().length === 0);
      await user.see({ role: "textbox", label: "Message Workbot" }, { value: "Keep this draft" });
      await user.screenshot();
    });
  }
  await step("unverified permissions do not turn an owner's display name into invitation access", async () => {
    await user.navigate(`${world.url}?sharing=on&persona=unknown`);
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ role: "textbox", label: "Message Workbot" });
    const controls = await probe.dom(removed);
    expect(controls.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Missing permission facts reveal no share fallback", `share controls=${controls.elements.length}; writes=${world.writes().length}`, controls.elements.length === 0 && world.writes().length === 0);
    await user.screenshot();
  });
  await step("a failed identity check keeps its recovery rather than offering sharing", async () => {
    await user.navigate(`${world.url}?sharing=on&persona=error`);
    await user.see({ role: "button", label: "Try again" });
    await user.notSee({ role: "button", label: "Share Workbot" });
    const controls = await probe.dom(removed);
    expect(controls.elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Identity failure grants no invitation access", `recovery visible; share controls=${controls.elements.length}; writes=${world.writes().length}`, controls.elements.length === 0 && world.writes().length === 0);
    await user.screenshot();
  });
});

invitationTest("an authorized owner still invites a coworker by email in Den", async ({ world, user, probe, step, evidence }) => {
  const email = world.invitation.email.replace("pending-link", "coworker");
  await step("the owner opens the existing email invitation form", async () => {
    await user.click({ role: "button", label: "Add member" });
    await user.see({ testId: "invite-email" });
    await user.see({ role: "button", label: "Send invite" });
    const form = await probe.dom('[data-testid="invite-email"]');
    expect(form.elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Real email invitations remain accessible", `email fields=${form.elements.length}; Send invite visible`, form.elements.length === 1);
    await user.screenshot();
  });
  await step("the owner sends the invitation to the typed coworker", async () => {
    await user.type({ testId: "invite-email" }, email);
    await user.click({ role: "button", label: "Send invite" });
    await user.see({ text: email });
    await user.notSee({ testId: "invite-email" });
    const sent = await probe.eventually(() => invitationWitnesses(world.den.admin).emails("organizationInvite", email), { within: 15_000, label: "the invitation email was captured locally", until: emails => emails.length === 1 });
    expect(sent).toHaveLength(1);
    evidence.recordAssertionEvidence("The genuine invitation sends an email", `invitation emails for the typed recipient=${sent.length}`, sent.length === 1);
    await user.screenshot();
  });
  await step("a member without invitation permission cannot retrieve its join token", async () => {
    await user.see({ text: email });
    const refused = await probe.api(world.teammate, `/v1/invitations/${world.invitation.id}/link`, { headers: { "x-openwork-org-id": world.organizationId } });
    expect(refused.response.status).toBe(403);
    expect(refused.text).not.toContain(world.invitation.token);
    evidence.recordAssertionEvidence("Invitation access checks are unchanged", `member invite-link request=${refused.response.status}; token disclosed=false`, refused.response.status === 403 && !refused.text.includes(world.invitation.token));
    await user.screenshot();
  });
});
