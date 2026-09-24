import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { modelsSignIn, modelsSignInFirstChat, modelsSignInSignedIn } from "../worlds/models-sign-in.ts";

type Browser = { see: (target: { role?: "button"; label?: string; text?: RegExp }, options?: { timeoutMs?: number }) => Promise<void>; click: (target: { role: "button"; label: string }) => Promise<void> };

/**
 * The sign-in page re-checks the OpenWork session whenever its tab gains
 * focus, and ignores a click that lands mid-check; a person just clicks again.
 */
async function continueToGoogle(browser: Browser) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await browser.see({ role: "button", label: "Continue to Google" }, { timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await browser.click({ role: "button", label: "Continue to Google" });
    try {
      await browser.see({ text: /is connected to OpenWork/ }, { timeoutMs: 20_000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

// Nobody thinks about models until one stops them. These are the four moments
// a person meets a model that needs their own Google sign-in, and in each one
// the sign-in happens right where they already are.
const library = spec.world(modelsSignIn, { timeout: 900_000, resources: { surfaces: ["desktop", "web"], services: ["den"], nativeReason: "Google sign-in leaves the desktop for the system browser; only the Electron app can show that hand-off." } });
const picker = spec.world(modelsSignIn, { timeout: 900_000, resources: { surfaces: ["desktop", "web"], services: ["den"], nativeReason: "Google sign-in leaves the desktop for the system browser; only the Electron app can show that hand-off." } });
const firstChat = spec.world(modelsSignInFirstChat, { timeout: 900_000, resources: { surfaces: ["desktop", "web"], services: ["den"], nativeReason: "Google sign-in leaves the desktop for the system browser; only the Electron app can show that hand-off." } });
const midChat = spec.world(modelsSignInSignedIn, { timeout: 900_000, resources: { surfaces: ["desktop", "web"], services: ["den"], nativeReason: "Google sign-in leaves the desktop for the system browser; only the Electron app can show that hand-off." } });

library("1. Library: I want to know which models I can use", async ({ world, user, agent, step, evidence }) => {
  await step("I open Library and choose Models: every provider my company gives me, with its models", async () => {
    await agent.run("route.extensions.skills");
    await user.click({ role: "button", label: "Models" });
    await user.see({ text: "Google Cloud" }, { timeoutMs: 120_000 });
    // The company's Anthropic arrives with cloud sync, a moment after Google Cloud.
    await user.see({ text: "Anthropic" }, { timeoutMs: 120_000 });
    await user.see({ role: "button", label: /^Google Cloud/ }, { text: /Sign in/ });
    await user.screenshot();
  });

  await step("Google Cloud's page says I'm not signed in and lists each model with who makes it", async () => {
    await user.click({ role: "button", label: /^Google Cloud/ });
    await user.see({ testId: "library-model-state" }, { text: "Not signed in. Uses your own Google account.", timeoutMs: 30_000 });
    await user.see({ testId: "library-model-list" }, { text: /2 models/ });
    await user.see({ testId: "library-model-list" }, { text: /Gemini 2\.5 Pro/ });
    await user.see({ role: "button", label: "Sign in with Google" });
    const member = await world.memberConnection();
    evidence.recordAssertionEvidence("Den agrees Sam is not signed in to Google Cloud yet", `ready: ${String(member?.ready)}`, member?.ready === false);
    await user.screenshot();
  });
});

picker("2. Picker: I want Gemini for this chat, so I sign in on its group and it's picked for me", async ({ world, user, probe, step, evidence }) => {
  await step("before: Gemini says Sign in to use, and picking it opens the picker at Google Cloud, with no sign-in dialog", async () => {
    await user.see({ role: "button", label: "Change model" }, { timeoutMs: 120_000 });
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s+/ });
    await user.see({ placeholder: "Search models..." }, { timeoutMs: 30_000 });
    await user.type({ placeholder: "Search models..." }, "Gemini");
    await user.see({ text: world.geminiProName }, { timeoutMs: 60_000 });
    await user.see({ text: "Sign in to use" });
    await user.screenshot();
    // The composer menu has no room to show sign-in progress, so it hands off to the picker.
    await user.click({ text: world.geminiProName });
    await user.see({ testId: "model-picker-group-sign-in" }, { text: "Sign in with Google", timeoutMs: 60_000 });
    await user.notSee({ text: "Log in to this provider to use the models" });
    await user.screenshot();
  });

  await step("I click Gemini 2.5 Pro: the group waits for my browser and the picker stays open", async () => {
    await user.click({ text: world.geminiProName });
    await user.see({ testId: "model-picker-group-sign-in" }, { text: /Finish signing in in your browser/, timeoutMs: 30_000 });
    const links = await probe.eventually(() => world.signInLinks(), { within: 30_000, label: "sign-in page opened in the browser", until: (urls) => urls.length > 0 });
    evidence.recordAssertionEvidence("the desktop opened OpenWork's sign-in page in the system browser", new URL(links[0] ?? "").pathname, links.length === 1);
    await user.screenshot();
  });

  await step("in the browser I continue to Google and approve", async () => {
    const [link] = await world.signInLinks();
    const google = await world.googleAnswers("approve");
    const browser = user.on(world.browser);
    await browser.navigate(link ?? "");
    await continueToGoogle(browser);
    google.close();
    await browser.screenshot();
  });

  await step("after: back in OpenWork, Gemini 2.5 Pro is picked and the picker has closed", async () => {
    const composer = await probe.eventually(() => probe.composer(), {
      within: 120_000, label: "Gemini picked after sign-in", until: (state) => state.selectedModelLabel?.includes("Gemini 2.5 Pro") === true,
    });
    await user.notSee({ testId: "model-picker-group-sign-in" });
    evidence.recordAssertionEvidence("the model Sam clicked is the conversation's model", `${composer.selectedModelLabel}; Google token exchanges: ${world.googleTokenExchanges().length}`, world.googleTokenExchanges().length === 1);
    expect(world.googleTokenExchanges()).toHaveLength(1);
    await user.screenshot();
  });
});

firstChat("3. First chat: my company's default needs my sign-in, and I can still start working", async ({ world, user, probe, step, evidence }) => {
  await step("before: the composer starts on a model that works, with a sign-in notice above it and no picker", async () => {
    await user.see({ testId: "model-sign-in-notice" }, { text: /Gemini 2\.5 Pro, Acme Studio's default, needs your Google sign-in\./, timeoutMs: 180_000 });
    await user.notSee({ text: "Select a model for this session." });
    const composer = await probe.composer();
    evidence.recordAssertionEvidence("the composer uses a working model instead of the one waiting on sign-in", String(composer.selectedModelLabel), !String(composer.selectedModelLabel).includes("Gemini"));
    expect(composer.selectedModelLabel).not.toContain("Gemini");
    await user.screenshot();
  });

  await step("I choose Sign in with Google and finish in the browser", async () => {
    await user.click({ role: "button", label: "Sign in with Google" });
    await user.see({ testId: "model-sign-in-notice" }, { text: /Finish signing in in your browser/, timeoutMs: 30_000 });
    const [link] = await probe.eventually(() => world.signInLinks(), { within: 30_000, label: "sign-in page opened", until: (urls) => urls.length > 0 });
    const google = await world.googleAnswers("approve");
    const browser = user.on(world.browser);
    await browser.navigate(link ?? "");
    await continueToGoogle(browser);
    google.close();
    await user.screenshot();
  });

  await step("after: the composer switches to the company's default and the notice is gone", async () => {
    const composer = await probe.eventually(() => probe.composer(), {
      within: 120_000, label: "company default restored", until: (state) => state.selectedModelLabel?.includes("Gemini 2.5 Pro") === true,
    });
    await user.notSee({ testId: "model-sign-in-notice" });
    evidence.recordAssertionEvidence("the composer uses Acme Studio's default after sign-in", String(composer.selectedModelLabel), true);
    await user.screenshot();
  });
});

midChat("4. Mid-chat: Google signs me out, and I keep going without leaving the conversation", async ({ world, user, probe, step, evidence }) => {
  await step("given Sam is chatting with Gemini 2.5 Pro and Google signs Sam out", async () => {
    await probe.eventually(() => probe.composer(), {
      within: 180_000, label: "Gemini ready in the composer", until: (state) => state.selectedModelLabel?.includes("Gemini 2.5 Pro") === true,
    });
    world.googleSignsSamOut();
    await user.type("composer", "Summarize the launch plan");
    await user.press("Enter");
    await user.see({ testId: "session-error-signed-out" }, { text: /Google signed you out, so Gemini 2\.5 Pro couldn't answer\./, timeoutMs: 120_000 });
    const refused = world.gatewayRequests().filter((request) => request.provider === world.googleCloudId && request.prompt);
    evidence.recordAssertionEvidence("the Gateway refused the Google Cloud request with sign-in required", `${refused.length} refused request(s)`, refused.length > 0);
    await user.see({ role: "button", label: "Sign in again" });
    await user.notSee({ text: "Choose group and credential set" });
    await user.screenshot();
  });

  await step("after: Use Claude switches this conversation and asks again, and the answer arrives", async () => {
    await user.click({ role: "button", label: /^Use Claude/ });
    await user.see({ text: world.answer }, { timeoutMs: 120_000 });
    const asked = world.gatewayRequests().filter((request) => request.provider === world.anthropicId && request.prompt);
    evidence.recordAssertionEvidence("the same message went to Anthropic without Sam retyping it", `${asked.length} request(s) to Anthropic carrying "Summarize the launch plan"`, asked.length > 0);
    expect(asked.length).toBeGreaterThan(0);
    await user.screenshot();
  });
});
