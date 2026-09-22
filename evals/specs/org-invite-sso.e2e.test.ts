import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ssoInvite } from "../worlds/den.ts";
import { invitationWitnesses, invitationsFor, membersFor, rows } from "../worlds/org-invite.ts";

for (const mismatch of [false, true]) {
  const test = spec.world((seed) => ssoInvite(seed, { mismatchedEmail: mismatch, role: "admin" }), { resources: { surfaces: ["web"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 600_000 });

  test(`SSO-enforced invitation ${mismatch ? "rejects a different IdP email without consuming the invite" : "joins the matching IdP email with the invited role"}`, async ({ world, user, probe, step }) => {
    const witnesses = invitationWitnesses(world.den.admin);
    const before = await witnesses.org(world.organizationId);
    const invitations = invitationsFor(before, world.invitee);
    expect(invitations).toEqual([expect.objectContaining({ status: "pending", role: "admin" })]);
    const otpBefore = await witnesses.emails("verification", world.invitee);

    await step("the invite routes through the organization's registered and enabled IdP", async () => {
      const configured = await witnesses.api("/v1/sso", { headers: { "x-openwork-org-id": world.organizationId } });
      expect(configured.response.ok, configured.text).toBe(true);
      expect(configured.body).toHaveProperty("connection.status", "enabled");
      await user.navigate(world.joinUrl);
      await user.see({ role: "button", label: "Sign in with SSO" }, { timeoutMs: 90_000 });
      await user.notSee({ role: "textbox", label: "Password" });
      await user.click({ role: "button", label: "Sign in with SSO" });
    });

    await step(mismatch ? "the actual IdP identity cannot claim another person's invitation" : "the actual IdP identity joins once, without an email OTP or role downgrade", async () => {
      if (mismatch) {
        await user.see({ text: /Switch accounts to continue\./ }, { timeoutMs: 90_000 });
        await user.see({ text: world.mismatchedEmail });
        await user.notSee({ role: "button", label: /^Join / });
        const org = await witnesses.org(world.organizationId);
        expect(invitationsFor(org, world.invitee)).toEqual(invitations);
        expect(membersFor(org, world.invitee)).toHaveLength(0);
        expect(membersFor(org, world.mismatchedEmail).some((member) => member.role === "admin")).toBe(false);
      } else {
        const org = await probe.eventually(() => witnesses.org(world.organizationId), { within: 90_000, label: "SSO invite membership", until: (value) => membersFor(value, world.invitee).length === 1 });
        expect(membersFor(org, world.invitee)).toEqual([expect.objectContaining({ role: "admin" })]);
        expect(invitationsFor(org, world.invitee).filter((invite) => invite.status === "pending")).toEqual([]);
        expect(rows(org.members).filter((member) => invitations.some((invite) => invite.id === member.inviteId) && (!member.userId || !member.joinedAt))).toEqual([]);
        const others = (value: Record<string, unknown>) => rows(value.members).filter((member) => !membersFor(value, world.invitee).includes(member));
        expect(others(org)).toEqual(others(before).filter((member) => !invitations.some((invite) => invite.id === member.inviteId)));
        await user.reload();
        expect(membersFor(await witnesses.org(world.organizationId), world.invitee)).toHaveLength(1);
      }
      await user.notSee({ role: "textbox", label: "Verification code" });
      expect(await witnesses.emails("verification", world.invitee)).toEqual(otpBefore);
      expect(await witnesses.emails("verification", world.mismatchedEmail)).toEqual([]);
    });
  });
}
