import { spec } from "@openwork/testkit";
import { ssoInvite } from "../worlds/den.ts";

const test = spec.world(ssoInvite, { needs: { placement: "local" } });

test("an invited person whose company uses SSO is sent to their identity provider, not asked for a password", async ({ world, user, step }) => {
  await user.navigate(world.joinUrl);
  await user.see({ role: "button", text: /sign in with sso/i }, { timeoutMs: 90_000 });
  await user.see({ text: world.invitee });
  await user.notSee({ role: "textbox", label: /password/i });

  await step("the invitation survives the identity-provider round trip", async () => {
    await user.click({ role: "button", text: /sign in with sso/i });
    await user.see({ text: /one click away|you're in|welcome to/i }, { timeoutMs: 120_000 });
    await user.notSee({ role: "textbox", label: /password/i });
  });

  await user.click({ role: "button", text: /^join /i });
  await user.see({ text: /download|install/i }, { timeoutMs: 90_000 });
});
