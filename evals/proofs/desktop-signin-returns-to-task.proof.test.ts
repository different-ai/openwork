import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { desktopSignInReturnsToTask } from "../worlds/desktop-signin-returns-to-task.ts";

const test = spec.world(desktopSignInReturnsToTask, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  timeout: 900_000,
});

const DRAFT = "Also flag every auto-renewal clause";
const PASTE_FIELD = { role: "textbox", label: "Sign-in link or one-time code" } as const;

/** The model a person sees on the visible composer. */
async function composerModel(probe: Probe) {
  const chips = await probe.dom('button[aria-label="Change model"]');
  return chips.elements.find((chip) => chip.rect.width > 0 && chip.rect.height > 0)?.text.trim() ?? "";
}

/** The app route on screen, the same on the desktop (hash) and the app in a browser (path). */
async function route(probe: Probe) {
  const url = await probe.url();
  if (url.startsWith("#")) return url.slice(1);
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

async function dismissAccountMenu(user: User, probe: Probe) {
  await user.press("Escape");
  await probe.eventually(() => probe.has("Log out"), {
    within: 5_000, label: "the account menu finishes closing", until: (visible) => !visible,
  });
}

async function signOut(user: User, probe: Probe) {
  await dismissAccountMenu(user, probe);
  await user.click({ testId: "account-status-menu" });
  await user.click({ role: "menuitem", label: "Log out" });
  await user.see({ role: "button", label: "Account and status" }, { timeoutMs: 30_000 });
  await dismissAccountMenu(user, probe);
}

test("a person using Desktop without an account chats on Auto, signs in, and comes back to the same conversation and draft", async ({ world, user, probe, step, evidence }) => {
  const conversationUrl = world.sessionPath;
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await step("a person without an account chats on Auto right away", async () => {
    await user.navigate(world.sessionUrl);
    await user.see("composer", { editable: true, timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Account and status" });
    const model = await probe.eventually(() => composerModel(probe), { within: 60_000, label: "Auto is the model", until: (label) => label.startsWith("Auto") });
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: world.reply }, { timeoutMs: 120_000 });
    const relayed = world.gatewayRequests().filter((request) => request.startsWith("POST /api/anonymous/v1/"));
    evidence.recordAssertionEvidence("the first answer arrives on Auto with no account", `account=signed out; model=${model}; free Auto calls through the app's relay as a guest: ${relayed.join(", ")}`, model.startsWith("Auto") && relayed.length > 0);
    expect(model.startsWith("Auto")).toBe(true);
    expect(relayed.length).toBeGreaterThan(0);
    await user.screenshot();
  });

  await step("Sign in keeps the conversation and its draft on screen while the browser finishes", async () => {
    await user.navigate(world.sessionUrl);
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    await user.type("composer", DRAFT, { replace: true });
    await user.click({ role: "button", label: "Sign in to OpenWork Cloud" });
    await user.see({ testId: "sign-in-handoff-notice" }, { timeoutMs: 30_000 });
    await user.see({ text: "Finish signing in in your browser" });
    await user.see({ text: "Your draft is saved" });
    await user.see({ role: "button", label: "Copy sign-in link" });
    await user.see({ text: world.reply });
    await user.see("composer", { text: DRAFT });
    const url = await route(probe);
    evidence.recordAssertionEvidence("the conversation stays put while sign-in finishes in the browser", `route=${url}; answer and draft on screen; notice offers Copy sign-in link, Paste sign-in code and Cancel`, url === conversationUrl);
    expect(url).toBe(conversationUrl);
    await user.screenshot();
  });

  let before = { sessions: 0, workspaces: 0 };
  await step("finishing sign-in returns to the same conversation with the draft, still on Auto, signed in to Acme", async () => {
    before = await world.localCounts();
    await user.click({ role: "button", label: "Paste sign-in code" });
    await user.type(PASTE_FIELD, await world.grantFor("riley"), { replace: true });
    await user.click({ role: "button", label: "Finish sign-in" });
    await user.see({ text: "Signed in to Acme" }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Riley — account and status" }, { timeoutMs: 60_000 });
    await user.see({ testId: "sign-in-draft-consent" }, { timeoutMs: 30_000 });
    await user.see("composer", { editable: true });
    await user.notSee({ text: DRAFT });
    await user.screenshot();
    await user.click({ role: "button", label: "Move draft to this account" });
    await user.see("composer", { text: DRAFT, timeoutMs: 30_000 });
    await user.see({ text: world.reply });
    await user.notSee({ testId: "sign-in-handoff-notice" });
    const url = await route(probe);
    const model = await composerModel(probe);
    evidence.recordAssertionEvidence("sign-in comes back to the task", `route=${url}; draft="${DRAFT}" in the composer; model=${model}; toast "Signed in to Acme"; account=Riley`, url === conversationUrl && model.startsWith("Auto"));
    expect(url).toBe(conversationUrl);
    expect(model.startsWith("Auto")).toBe(true);
    await user.screenshot();
  });

  await step("no second workspace or conversation was opened", async () => {
    await user.see({ text: "Contract summary" });
    const after = await world.localCounts();
    evidence.recordAssertionEvidence("the same conversation, not a copy", `conversations ${before.sessions} → ${after.sessions}; workspaces ${before.workspaces} → ${after.workspaces}`, after.sessions === before.sessions && after.workspaces === before.workspaces);
    expect(after).toEqual(before);
  });

  await step("another account finishing the pending sign-in cannot receive the signed-out draft without consent", async () => {
    await signOut(user, probe);
    await user.type("composer", "Private signed-out draft", { replace: true });
    await user.click({ role: "button", label: "Sign in to OpenWork Cloud" });
    await user.see({ testId: "sign-in-handoff-notice" }, { timeoutMs: 30_000 });
    await user.click({ role: "button", label: "Paste sign-in code" });
    await user.type(PASTE_FIELD, await world.grantFor("jordan"), { replace: true });
    await user.click({ role: "button", label: "Finish sign-in" });
    await user.see({ role: "button", label: "Jordan — account and status" }, { timeoutMs: 90_000 });
    await user.see({ testId: "sign-in-draft-consent" }, { timeoutMs: 30_000 });
    await user.see("composer", { editable: true });
    await user.notSee({ text: "Private signed-out draft" });
    await user.screenshot();
    await user.click({ role: "button", label: "Keep draft signed out" });
    await user.notSee({ testId: "sign-in-draft-consent" });
    await user.reload();
    await user.see("composer", { editable: true, timeoutMs: 90_000 });
    await user.notSee({ text: "Private signed-out draft" });
    const url = await route(probe);
    evidence.recordAssertionEvidence("sign-in alone never transfers an unowned local draft", `account=Jordan; route=${url}; signed-out draft absent before consent and after declining and reloading`, url === conversationUrl);
    expect(url).toBe(conversationUrl);
    await user.screenshot();
  });

  await step("another member's sign-in does not reuse an unfinished one, and the draft stays with its owner", async () => {
    await signOut(user, probe);
    const note = "Riley's unsent note";
    await user.type("composer", note, { replace: true });
    await user.click({ role: "button", label: "Sign in to OpenWork Cloud" });
    await user.see({ testId: "sign-in-handoff-notice" }, { timeoutMs: 30_000 });
    // Riley walks away. Jordan signs in from Settings on the same desktop.
    await user.navigate(world.settingsUrl);
    await user.click({ role: "button", label: "Paste sign-in code" });
    await user.type(PASTE_FIELD, await world.grantFor("jordan"), { replace: true });
    await user.click({ role: "button", label: "Finish sign-in" });
    await user.see({ role: "button", label: "Jordan — account and status" }, { timeoutMs: 90_000 });
    const landed = await probe.eventually(() => route(probe), {
      within: 60_000, label: "chat opens after Jordan signs in",
      until: (url) => !url.includes("/onboarding") && !url.includes("/settings"),
    });
    await user.notSee({ text: "Signed in to Acme" });
    await user.navigate(world.sessionUrl);
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    await user.see("composer", { editable: true });
    await user.notSee({ text: note });
    await user.notSee({ text: DRAFT });
    evidence.recordAssertionEvidence("an unfinished sign-in is not completed by someone else", `Jordan landed on ${landed}, not ${conversationUrl}; no return toast; Riley's note and draft are not in Jordan's composer`, landed !== conversationUrl);
    expect(landed).not.toBe(conversationUrl);
    await user.screenshot();
  });
});
