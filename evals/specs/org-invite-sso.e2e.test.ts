import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ssoInvite } from "../worlds/den.ts";
import { invitationWitnesses, invitationsFor, membersFor, rows } from "../worlds/org-invite.ts";

for (const mismatch of [false, true]) {
  const test = spec.world((seed) => ssoInvite(seed, { mismatchedEmail: mismatch, role: "admin" }), { resources: { surfaces: ["web"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 600_000 });

  test(`SSO-enforced invitation ${mismatch ? "rejects a different IdP email without consuming the invite" : "joins the matching IdP email with the invited role"}`, async ({ world, user, probe, step, evidence }) => {
    const witnesses = invitationWitnesses(world.den.admin);
    const before = await witnesses.org(world.organizationId);
    const invitations = invitationsFor(before, world.invitee);
    expect(invitations).toEqual([expect.objectContaining({ status: "pending", role: "admin" })]);
    const otpBefore = await witnesses.emails("verification", world.invitee);

    await step("before: the invitation offers only the organization's enabled SSO sign-in", async () => {
      const configured = await witnesses.api("/v1/sso", { headers: { "x-openwork-org-id": world.organizationId } });
      expect(configured.response.ok, configured.text).toBe(true);
      expect(configured.body).toHaveProperty("connection.status", "enabled");
      await user.navigate(world.joinUrl);
      await user.see({ role: "button", label: "Sign in with SSO" }, { timeoutMs: 90_000 });
      await user.notSee({ role: "textbox", label: /^password$/i });
      evidence.recordAssertionEvidence("The pending admin invitation requires the enabled IdP", `${invitations.length} pending admin invitation; SSO offered without a password input`, true);
      await user.screenshot();
    });

    await step(mismatch ? "after: a different IdP identity cannot claim the invitation" : "after: the invited IdP identity joins once as admin", async () => {
      await user.click({ role: "button", label: "Sign in with SSO" });
      if (mismatch) {
        await user.see({ text: /Switch accounts to continue\./ }, { timeoutMs: 90_000 });
        await user.see({ text: world.mismatchedEmail });
        await user.notSee({ role: "button", label: /^Join / });
        const org = await witnesses.org(world.organizationId);
        expect(invitationsFor(org, world.invitee)).toEqual(invitations);
        expect(membersFor(org, world.invitee)).toHaveLength(0);
        expect(membersFor(org, world.mismatchedEmail).some((member) => member.role === "admin")).toBe(false);
        evidence.recordAssertionEvidence("The wrong identity cannot consume or gain the invited role", `${invitationsFor(org, world.invitee).length} invitation remains pending; ${membersFor(org, world.invitee).length} invited memberships; no admin role granted to the mismatched identity`, true);
      } else {
        await probe.eventually(async () => membersFor(await witnesses.org(world.organizationId), world.invitee), {
          within: 90_000,
          label: "SSO invite membership",
          until: (members) => members.length === 1,
        }).catch(async (error: unknown) => {
          await user.screenshot().catch(() => undefined);
          throw error;
        });
        const org = await witnesses.org(world.organizationId);
        expect(membersFor(org, world.invitee)).toEqual([expect.objectContaining({ role: "admin" })]);
        expect(invitationsFor(org, world.invitee).filter((invite) => invite.status === "pending")).toEqual([]);
        expect(rows(org.members).filter((member) => invitations.some((invite) => invite.id === member.inviteId) && (!member.userId || !member.joinedAt))).toEqual([]);
        const others = (value: Record<string, unknown>) => rows(value.members).filter((member) => !membersFor(value, world.invitee).includes(member));
        expect(others(org)).toEqual(others(before).filter((member) => !invitations.some((invite) => invite.id === member.inviteId)));
        await user.see({ role: "heading", label: "Download OpenWork" }, { timeoutMs: 90_000 });
        await user.reload();
        await user.see({ role: "heading", label: "Download OpenWork" }, { timeoutMs: 90_000 });
        const afterReload = membersFor(await witnesses.org(world.organizationId), world.invitee);
        expect(afterReload).toHaveLength(1);
        evidence.recordAssertionEvidence("The invited identity joins exactly once with the admin role", `${afterReload.length} membership after reload; role admin; other members unchanged`, true);
      }
      await user.screenshot();
    });

    await step("SSO never sends a redundant mailbox verification challenge", async () => {
      await user.notSee({ role: "textbox", label: /^verification code$/i });
      const inviteeEmails = await witnesses.emails("verification", world.invitee);
      const mismatchEmails = await witnesses.emails("verification", world.mismatchedEmail);
      expect(inviteeEmails).toEqual(otpBefore);
      expect(mismatchEmails).toEqual([]);
      evidence.recordAssertionEvidence("Neither SSO identity is asked for an email OTP", `${inviteeEmails.length - otpBefore.length} new invitee OTP emails; ${mismatchEmails.length} mismatched-identity OTP emails; no verification input`, true);
    });
  });
}
