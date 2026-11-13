import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotAccountMenu } from "../worlds/workbot-account-menu.ts";

const test = spec.world(workbotAccountMenu, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

test("a person signs out of Workbot, or switches workspace, from the avatar menu", async ({ world, user, probe, step, evidence }) => {

  await step("after: the avatar opens a menu with the account, its workspace and Sign out", async () => {
    await user.navigate(world.page());
    await user.click({ testId: "workbot-account-menu" });
    await user.see({ text: "sam@example.test" });
    await user.see({ testId: "workbot-account-workspace", text: "Example Team" });
    await user.see({ role: "menuitem", text: "Switch workspace" });
    await user.see({ role: "menuitem", text: "Your dashboard" });
    await user.see({ role: "menuitem", text: "Sign out" });
    await user.screenshot();
  });

  await step("a failed sign-out says so and stays signed in, then trying again lands on the signed-out page", async () => {
    await user.click({ role: "menuitem", text: "Sign out" });
    await user.see({ role: "alert", text: "Workbot couldn't sign you out. Check your connection and try again." });
    expect(new URL(await probe.url()).pathname).toBe("/");
    await user.screenshot();
    await user.click({ role: "menuitem", text: "Sign out" });
    await user.see({ role: "heading", text: "You're signed out of Workbot" });
    await user.see({ role: "link", text: "Sign in" });
    expect(await probe.url()).toMatch(/\/auth\/signed-out$/);
    expect(world.logouts()).toBe(2);
    evidence.recordAssertionEvidence("Sign out ends the sign-in without signing straight back in", "The second sign-out reached Workbot's real /auth/logout and the page settled on /auth/signed-out, not on Den's sign-in.", world.logouts() === 2);
    await user.screenshot();
  });

  await step("Switch workspace sends the person to Den's workspace chooser", async () => {
    await user.navigate(world.page());
    await user.click({ testId: "workbot-account-menu" });
    await user.click({ role: "menuitem", text: "Switch workspace" });
    await user.see({ role: "heading", text: "Choose a workspace" });
    expect(world.chooserRequests()).toEqual([true]);
    evidence.recordAssertionEvidence("Switch workspace asks for the chooser", "Workbot's real /auth/login was asked for the workspace chooser.", world.chooserRequests().at(-1) === true);
    await user.screenshot();
  });
});
