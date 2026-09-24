import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denLibraryModels, denLibraryModelsAsAdmin } from "../worlds/den-library-models.ts";

// Models live in My Library, next to connectors, skills and plugins. A model
// that needs the person's own sign-in gets a Sign in button right there; no
// separate "My Model Connections" page, no dialog.
const test = spec.world(denLibraryModels, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });
const adminTest = spec.world(denLibraryModelsAsAdmin, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("a member: I want to use Gemini, so I sign in with my own Google account right from My Library", async ({ world, user, probe, step, evidence }) => {
  await step("before: My Library shows every model my company gives me, and which one needs my sign-in", async () => {
    await user.see({ role: "tab", label: "Models" }, { timeoutMs: 120_000 });
    await user.see({ text: "Google Cloud" }, { timeoutMs: 60_000 });
    await user.see({ text: "Anthropic" });
    await user.see({ text: "Set up" });
    await user.see({ text: "Ready" });
    await user.see({ role: "button", label: "Sign in" });
    const served = await world.usableModelNames(world.sam);
    evidence.recordAssertionEvidence("Den serves Sam no Google Cloud models yet", `usable Google Cloud models for Sam: ${served.length}`, served.length === 0);
    expect(served).toEqual([]);
    await user.screenshot();
  });

  await step("the old My Model Connections address opens this same list, so installed desktop apps still land here", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/model-connections`);
    const landed = await probe.eventually(() => world.location(), {
      within: 30_000, label: "redirect to My Library, Models", until: (path) => path.startsWith("/dashboard/library"),
    });
    evidence.recordAssertionEvidence("/dashboard/model-connections forwards to My Library", landed, landed === "/dashboard/library?show=models");
    expect(landed).toBe("/dashboard/library?show=models");
    await user.see({ text: "Google Cloud" }, { timeoutMs: 60_000 });
    await user.notSee({ text: "My Model Connections" });
    await user.screenshot();
  });

  await step("I start signing in, change my mind and cancel: nothing changes", async () => {
    await user.click({ role: "button", label: "Sign in" });
    await user.see({ text: "Finish signing in in your browser" }, { timeoutMs: 30_000 });
    const tab = await world.signInTab();
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
    await world.closeTab(tab);
    await user.see({ role: "button", label: "Sign in" }, { timeoutMs: 15_000 });
    await user.notSee({ text: "Finish signing in in your browser" });
    evidence.recordAssertionEvidence("no Google token was requested", `token exchanges: ${world.googleTokenExchanges().length}`, world.googleTokenExchanges().length === 0);
    expect(world.googleTokenExchanges()).toHaveLength(0);
  });

  await step("if Google says no, Library says the sign-in didn't finish and offers to try again", async () => {
    await user.click({ role: "button", label: "Sign in" });
    const tab = await world.signInTab();
    const google = await world.googleAnswers(tab, "deny");
    await user.on(tab).see({ role: "button", label: "Continue to Google" }, { timeoutMs: 60_000 });
    await user.on(tab).click({ role: "button", label: "Continue to Google" });
    await user.on(tab).see({ text: "Google access was denied." }, { timeoutMs: 60_000 });
    await user.on(tab).screenshot();
    google.close();
    await world.closeTab(tab);
    await user.see({ text: "Sign-in didn't finish." }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: "Try again" });
    const [connection] = await world.memberConnections(world.sam);
    evidence.recordAssertionEvidence("Sam is still not signed in", `ready: ${String(connection?.ready)}; token exchanges: ${world.googleTokenExchanges().length}`, connection?.ready === false);
    expect(connection?.ready).toBe(false);
    await user.screenshot();
  });

  await step("I open Google Cloud: it says I'm not signed in and lists its models with who made them", async () => {
    await user.click({ role: "link", label: /Google Cloud/ });
    await user.see({ role: "heading", label: "Google Cloud" }, { timeoutMs: 60_000 });
    await user.see({ testId: "model-provider-state" }, { text: "Not signed in. Uses your own Google account." });
    await user.see({ testId: "model-provider-models" }, { text: /2 models/ });
    await user.see({ testId: "model-provider-model" }, { text: /Gemini 2\.5/ });
    await user.see({ role: "button", label: "Sign in with Google" });
    await user.screenshot();
  });

  await step("I choose Sign in with Google and approve in the tab that opens", async () => {
    await user.click({ role: "button", label: "Sign in with Google" });
    const tab = await world.signInTab();
    const google = await world.googleAnswers(tab, "approve");
    await user.on(tab).see({ role: "button", label: "Continue to Google" }, { timeoutMs: 60_000 });
    await user.on(tab).click({ role: "button", label: "Continue to Google" });
    await user.on(tab).see({ text: /is connected to OpenWork/ }, { timeoutMs: 60_000 });
    const [request] = google.seen();
    evidence.recordAssertionEvidence(
      "Google was asked to show its account chooser for this organization's OAuth client",
      `client_id ${request?.clientId}; prompt "${request?.prompt}"`,
      request?.clientId === world.oauthClientId && (request?.prompt ?? "").includes("select_account"),
    );
    expect(request?.prompt).toBe("consent select_account");
    await user.on(tab).screenshot();
    google.close();
    await world.closeTab(tab);
  });

  await step("after: the page says which Google account is in use, and Den now serves me Google Cloud's models", async () => {
    await user.see({ testId: "den-toast" }, { text: `Signed in to Google as ${world.googleAccount}`, timeoutMs: 60_000 });
    await user.see({ testId: "model-provider-state" }, { text: `Signed in as ${world.googleAccount}` });
    await user.notSee({ role: "button", label: "Sign in with Google" });
    const served = await world.usableModelNames(world.sam);
    evidence.recordAssertionEvidence("Den serves Sam Google Cloud's models", served.join(", "), served.length === 2);
    expect(served).toHaveLength(2);
    expect(world.googleTokenExchanges()).toEqual([{ clientId: world.oauthClientId }]);
    await user.screenshot();
  });

  await step("back in My Library Google Cloud is ready for me, and Maya in the same company still signs in with her own account", async () => {
    await user.click({ role: "link", label: "My Library" });
    await user.see({ text: "Google Cloud" }, { timeoutMs: 60_000 });
    await user.notSee({ role: "button", label: "Sign in" });
    const [maya] = await world.memberConnections(world.maya);
    const mayaModels = await world.usableModelNames(world.maya);
    evidence.recordAssertionEvidence("Maya is not signed in by Sam's sign-in", `Maya ready: ${String(maya?.ready)}; Maya's usable Google Cloud models: ${mayaModels.length}`, maya?.ready === false && mayaModels.length === 0);
    expect(maya?.ready).toBe(false);
    expect(mayaModels).toEqual([]);
    await user.screenshot();
  });

  await step("I can switch account or sign out from the menu, and signing out asks first", async () => {
    await user.click({ role: "link", label: /Google Cloud/ });
    await user.see({ role: "button", label: "More for Google Cloud" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "More for Google Cloud" });
    await user.see({ role: "menuitem", label: "Switch account" });
    await user.screenshot();
    await user.click({ role: "menuitem", label: "Sign out" });
    await user.see({ testId: "confirm-dialog" }, { text: /You can't use these models until you sign in again/ });
    await user.screenshot();
    await user.click({ role: "button", label: "Sign out" });
    await user.see({ testId: "model-provider-state" }, { text: "Not signed in. Uses your own Google account.", timeoutMs: 60_000 });
    const served = await world.usableModelNames(world.sam);
    evidence.recordAssertionEvidence("signing out stops Den serving Sam those models and revokes the Google token", `usable models: ${served.length}; Google revocations: ${world.googleRevocations()}`, served.length === 0 && world.googleRevocations() >= 1);
    expect(served).toEqual([]);
    expect(world.googleRevocations()).toBeGreaterThanOrEqual(1);
    await user.screenshot();
  });
});

adminTest("an admin: I want everyone to start new chats on Gemini 2.5 Pro, without taking away their own pick", async ({ world, user, step, evidence }) => {
  await step("before: AI Providers has Default for new chats, and nothing is chosen yet", async () => {
    await user.see({ testId: "default-model-panel" }, { timeoutMs: 120_000 });
    await user.see({ text: "Everyone starts here. People can still pick another model." });
    await user.see({ role: "button", label: "Default for new chats" }, { text: /No default/ });
    const before = await world.defaultModelFor(world.sam);
    evidence.recordAssertionEvidence("Den has no default for Sam yet", JSON.stringify(before), before.configured === null && before.defaultModel === null);
    expect(before.configured).toBeNull();
    await user.screenshot();
  });

  await step("the admin picks Gemini 2.5 Pro", async () => {
    await user.click({ role: "button", label: "Default for new chats" });
    await user.click({ role: "option", label: /^Gemini 2\.5 Pro/ });
    await user.see({ testId: "den-toast" }, { text: /New chats start on Gemini 2\.5 Pro/, timeoutMs: 30_000 });
    await user.screenshot();
  });

  await step("after: Sam and Maya both start there, and Den says it needs each person's own Google sign-in", async () => {
    await user.see({ role: "button", label: "Default for new chats" }, { text: /Gemini 2\.5 Pro/ });
    const sam = await world.defaultModelFor(world.sam);
    const maya = await world.defaultModelFor(world.maya);
    const read = (value: Record<string, unknown>) => {
      const model = value.defaultModel;
      return typeof model === "object" && model !== null ? { name: Reflect.get(model, "name"), needsSignIn: Reflect.get(model, "needsSignIn") } : null;
    };
    evidence.recordAssertionEvidence("members get the admin's default, marked as needing their own sign-in", `Sam: ${JSON.stringify(read(sam))}; Maya: ${JSON.stringify(read(maya))}`,
      read(sam)?.name === "Gemini 2.5 Pro" && read(sam)?.needsSignIn === true && read(maya)?.needsSignIn === true);
    expect(read(sam)).toEqual({ name: "Gemini 2.5 Pro", needsSignIn: true });
    expect(read(maya)).toEqual({ name: "Gemini 2.5 Pro", needsSignIn: true });
    await user.screenshot();
  });
});
