import { spec } from "@openwork/testkit";
import { denManageAsAdmin } from "../worlds/den-library-manage.ts";

// Steps that sign someone out or take an app away ask first.
const test = spec.world(denManageAsAdmin, { timeout: 600_000 });

test("an admin: I want one Slack account for everyone, and to remove it later without surprises", async ({ world, user, probe, step }) => {
  const dialogClosed = async () => {
    await probe.eventually(() => probe.dom('[data-testid="confirm-dialog"]'), {
      within: 10_000, label: "the confirm dialog closed", until: (found) => found.elements.length === 0,
    });
    await user.notSee({ testId: "confirm-dialog" });
  };

  await step("1. I add Slack and sign in once to try it", async () => {
    await user.see({ testId: "connectors-empty" }, { timeoutMs: 120_000 });
    await user.click({ role: "link", label: "Add connector" });
    await user.click({ role: "link", label: "Add Slack" });
    await user.click({ role: "button", label: "Sign in with Slack" });
    await user.see({ role: "heading", label: "Slack passed all 4 checks" }, { timeoutMs: 120_000 });
    const tab = await world.signInTab({ timeoutMs: 1_000 });
    if (tab?.client.targetId) await world.web.client.send("Target.closeTarget", { targetId: tab.client.targetId });
    await user.screenshot();
  });

  await step("2. I pick One account for everyone: OpenWork warns that it signs me out first", async () => {
    await user.click({ role: "radio", label: /One account for everyone/ });
    await user.see({ testId: "step-footer-note" }, { text: "Next, sign in with the Slack account everyone will use." });
    await user.click({ role: "button", label: "Continue" });
    await user.see({ testId: "confirm-dialog" }, { text: /Switch to one account for everyone\?/ });
    await user.see({ text: "This signs you out of Slack. Next, you sign in with the Slack account everyone will use." });
    await user.screenshot();
  });

  await step("3. I cancel and nothing changes", async () => {
    await user.click({ testId: "confirm-dialog-cancel" });
    await dialogClosed();
    await user.see({ role: "heading", label: "Slack passed all 4 checks" });
    await user.screenshot();
  });

  await step("4. I confirm and sign in with the account everyone will use", async () => {
    await user.click({ role: "button", label: "Continue" });
    await user.click({ role: "button", label: "Sign out and continue" });
    await user.see({ text: "Sign in with the Slack account everyone will use." }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Sign in with Slack" });
    await user.see({ role: "heading", label: "Slack passed all 4 checks" }, { timeoutMs: 120_000 });
    const tab = await world.signInTab({ timeoutMs: 1_000 });
    if (tab?.client.targetId) await world.web.client.send("Target.closeTarget", { targetId: tab.client.targetId });
    await user.click({ role: "button", label: "Add Slack" });
    await user.see({ testId: "den-toast" }, { text: /Slack is ready/, timeoutMs: 60_000 });
    await user.see({ testId: "admin-connectors" }, { text: /One account for everyone/, timeoutMs: 60_000 });
    await user.screenshot();
  });

  await step("5. I choose Remove on Slack: OpenWork asks first, and Cancel keeps it", async () => {
    await user.click({ role: "button", label: "More for Slack" });
    await user.click({ role: "menuitem", label: "Remove" });
    await user.see({ testId: "confirm-dialog" }, { text: /Remove Slack\?/ });
    await user.see({ text: "Nobody can use it anymore. This cannot be undone." });
    await user.screenshot();
    await user.click({ testId: "confirm-dialog-cancel" });
    await dialogClosed();
    await user.see({ testId: "admin-connectors" }, { text: /Slack/ });
  });

  await step("after: I confirm Remove and Slack is gone", async () => {
    await user.click({ role: "button", label: "More for Slack" });
    await user.click({ role: "menuitem", label: "Remove" });
    await user.click({ role: "button", label: "Remove" });
    await user.see({ testId: "den-toast" }, { text: /Slack is removed/, timeoutMs: 60_000 });
    await user.see({ testId: "connectors-empty" }, { timeoutMs: 60_000 });
    await user.screenshot();
  });
});
