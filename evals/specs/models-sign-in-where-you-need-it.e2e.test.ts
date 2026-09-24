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

type Probe = { composer: () => Promise<{ route: string; selectedModelLabel: string; runTaskVisible: boolean; composerEditable: boolean }> };

/**
 * Right after launch the new-session screen can remount while the workspace
 * finishes starting, dropping anything typed. A person starts once the screen
 * has stopped changing; so do these flows.
 */
async function waitForSettledScreen(probe: Probe) {
  let last = "";
  let steady = 0;
  for (let attempt = 0; attempt < 120 && steady < 8; attempt += 1) {
    const state = await probe.composer();
    const snapshot = JSON.stringify([state.route, state.selectedModelLabel, state.runTaskVisible, state.composerEditable]);
    steady = snapshot === last ? steady + 1 : 0;
    last = snapshot;
    await new Promise((resolve) => setTimeout(resolve, 500));
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
    await waitForSettledScreen(probe);
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

firstChat("3. First chat: the model I picked needs my Google sign-in, so my message waits and sends once I sign in", async ({ world, user, probe, step, evidence }) => {
  await step("before: new chats start on Gemini 2.5 Pro, the model I picked, and the model button says Sign in", async () => {
    const composer = await probe.eventually(() => probe.composer(), {
      within: 180_000, label: "Sam's pick in the composer", until: (state) => state.selectedModelLabel?.includes("Gemini 2.5 Pro") === true,
    });
    await user.see({ testId: "model-select-sign-in" }, { text: "Sign in", timeoutMs: 60_000 });
    await user.notSee({ text: "Select a model for this session." });
    evidence.recordAssertionEvidence("the composer keeps the model Sam picked instead of swapping it for one that works", String(composer.selectedModelLabel), String(composer.selectedModelLabel).includes("Gemini 2.5 Pro"));
    await user.screenshot();
  });

  await step("I send my message: it is kept, dimmed, and one card asks me to sign in", async () => {
    await user.type("composer", "Summarize the launch plan");
    await user.press("Enter");
    await user.see({ testId: "held-send-card" }, { text: /Gemini 2\.5 Pro needs your Google sign-in\./, timeoutMs: 60_000 });
    await user.see({ testId: "held-send-card" }, { text: /Your message is kept\. It sends once you're signed in\./ });
    await user.see({ testId: "held-send-message" }, { text: /Summarize the launch plan/ });
    await user.see({ role: "button", label: "Switch model" });
    const sent = world.gatewayRequests().filter((request) => request.provider === world.googleCloudId && request.prompt);
    evidence.recordAssertionEvidence("nothing went to Google Cloud before Sam signed in", `${sent.length} request(s)`, sent.length === 0);
    expect(sent).toHaveLength(0);
    await user.screenshot();
  });

  await step("I choose Sign in with Google and finish in the browser", async () => {
    await user.click({ role: "button", label: "Sign in with Google" });
    await user.see({ testId: "held-send-card" }, { text: /Finish signing in in your browser/, timeoutMs: 30_000 });
    const [link] = await probe.eventually(() => world.signInLinks(), { within: 30_000, label: "sign-in page opened", until: (urls) => urls.length > 0 });
    const google = await world.googleAnswers("approve");
    const browser = user.on(world.browser);
    await browser.navigate(link ?? "");
    await continueToGoogle(browser);
    google.close();
    await browser.screenshot();
  });

  await step("after: my message sends by itself, without retyping, and goes to Google Cloud", async () => {
    const asked = await probe.eventually(async () => world.gatewayRequests().filter((request) => request.provider === world.googleCloudId && request.prompt), {
      within: 180_000, label: "kept message sent to Google Cloud", until: (requests) => requests.length > 0,
    });
    await user.notSee({ testId: "held-send-card" });
    await user.see({ text: "Summarize the launch plan" });
    const composer = await probe.composer();
    evidence.recordAssertionEvidence("the kept message went to Google Cloud after sign-in, and the composer is empty", `${asked.length} request(s) carrying "Summarize the launch plan"; draft ${JSON.stringify(composer.draftText)}`, asked.length > 0 && composer.draftText === "");
    expect(composer.draftText).toBe("");
    await user.screenshot();
  });
});

midChat("4. Mid-chat: Google signs me out, and I sign in again without leaving the conversation", async ({ world, user, probe, step, evidence }) => {
  await step("given Sam is chatting with Gemini 2.5 Pro and Google signs Sam out", async () => {
    await probe.eventually(() => probe.composer(), {
      within: 180_000, label: "Gemini ready in the composer", until: (state) => state.selectedModelLabel?.includes("Gemini 2.5 Pro") === true,
    });
    await user.notSee({ testId: "model-select-sign-in" });
    await waitForSettledScreen(probe);
    world.googleSignsSamOut();
    await user.type("composer", "Summarize the launch plan");
    // Sam sends once the message is in the box and Run task is ready.
    await probe.eventually(() => probe.composer(), {
      within: 60_000, label: "message ready to send", until: (state) => state.draftText.includes("Summarize the launch plan") && state.runTaskEnabled && !state.modelUnavailable,
    });
    await user.press("Enter");
    await user.see({ testId: "session-error-signed-out" }, { text: /Google signed you out, so Gemini 2\.5 Pro couldn't answer\./, timeoutMs: 120_000 });
    await user.see({ testId: "session-error-signed-out" }, { text: /Your message is kept\. It sends again once you're signed in\./ });
    const refused = world.gatewayRequests().filter((request) => request.provider === world.googleCloudId && request.prompt);
    evidence.recordAssertionEvidence("the Gateway refused the Google Cloud request with sign-in required", `${refused.length} refused request(s)`, refused.length > 0);
    await user.see({ role: "button", label: "Sign in again" });
    await user.see({ role: "button", label: "Switch model" });
    await user.notSee({ text: /^Use / });
    await user.notSee({ text: "Choose group and credential set" });
    await user.screenshot();
  });

  let askedBeforeSignIn = 0;
  await step("I choose Sign in again and finish in the browser", async () => {
    askedBeforeSignIn = world.gatewayRequests().filter((request) => request.provider === world.googleCloudId && request.prompt).length;
    await user.click({ role: "button", label: "Sign in again" });
    const [link] = await probe.eventually(() => world.signInLinks(), { within: 60_000, label: "sign-in page opened", until: (urls) => urls.length > 0 });
    const google = await world.googleAnswers("approve");
    const browser = user.on(world.browser);
    await browser.navigate(link ?? "");
    await continueToGoogle(browser);
    google.close();
    await browser.screenshot();
  });

  await step("after: the same message is asked again without retyping", async () => {
    const asked = await probe.eventually(async () => world.gatewayRequests().filter((request) => request.provider === world.googleCloudId && request.prompt), {
      within: 180_000, label: "message asked again after sign-in", until: (requests) => requests.length > askedBeforeSignIn,
    });
    await user.notSee({ text: /Finish signing in in your browser/ });
    const composer = await probe.composer();
    evidence.recordAssertionEvidence("after sign-in the message went to Google Cloud again, and Sam didn't retype it", `${asked.length - askedBeforeSignIn} new request(s) carrying "Summarize the launch plan"; draft ${JSON.stringify(composer.draftText)}; Google token exchanges: ${world.googleTokenExchanges().length}`, asked.length > askedBeforeSignIn && composer.draftText === "");
    expect(asked.length).toBeGreaterThan(askedBeforeSignIn);
    expect(composer.draftText).toBe("");
    await user.screenshot();
  });
});
