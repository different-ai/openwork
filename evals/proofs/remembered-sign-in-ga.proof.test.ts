import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { rememberedSignInGa } from "../worlds/remembered-sign-in-ga.ts";

const test = spec.world(rememberedSignInGa, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

test("a returning password member skips the email-only step without enabling a feature", async ({ world, user, probe, step, evidence }) => {
  const member = user.on(world.web);
  const browser = probe.on(world.web);

  await step("before: a fresh browser asks the member for an email before a password", async () => {
    await member.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 60_000 });
    await member.see({ role: "button", label: "Next" });
    await member.notSee({ role: "textbox", label: /^password$/i });
    await member.notSee({ text: "Last used" });
    const cookie = await world.rememberedCookie();
    evidence.recordAssertionEvidence("A browser without a remembered method starts email-first", `remembered cookie=${JSON.stringify(cookie)}; email and Next are visible; password is absent`, cookie === null);
    expect(cookie).toBeNull();
    await member.screenshot();
  });

  await step("when the member signs in with a password, Den remembers that method without a feature override", async () => {
    await member.type({ role: "textbox", label: /^email$/i }, world.account.email);
    await member.click({ role: "button", label: "Next" });
    await member.see({ role: "textbox", label: /^password$/i });
    await member.type({ role: "textbox", label: /^password$/i }, world.account.password, { sensitive: true });
    await member.click({ role: "button", label: "Sign in" });
    await member.see({ testId: "workspace-switcher-trigger" }, { timeoutMs: 60_000 });
    const cookie = await world.rememberedCookie();
    const longLived = typeof cookie?.expires === "number" && cookie.expires > Date.now() / 1000 + 300 * 24 * 60 * 60;
    evidence.recordAssertionEvidence("A real password sign-in writes the readable long-lived method cookie", `cookie=${JSON.stringify(cookie)}; expires in more than 300 days=${longLived}; no feature overrides arranged`, cookie?.value === "password" && cookie.httpOnly === false && cookie.sameSite === "Lax" && longLived);
    expect(cookie).toMatchObject({ value: "password", path: "/", sameSite: "Lax", httpOnly: false });
    expect(longLived).toBe(true);
    await member.screenshot();
  });

  await step("after: signing out opens the remembered password form with Last used instead of an email-only step", async () => {
    await member.click({ testId: "workspace-switcher-trigger" });
    await member.click({ role: "button", label: "Sign out" });
    await member.see({ testId: "remembered-password-form" }, { timeoutMs: 60_000 });
    await member.see({ role: "textbox", label: /^password$/i });
    await member.see({ text: "Last used" });
    await member.see({ role: "button", label: "Continue with Google" });
    await member.see({ role: "button", label: "Continue with GitHub" });
    await member.notSee({ role: "button", label: "Next" });
    const form = await browser.dom('[data-testid="remembered-password-form"][data-last-used="true"]');
    evidence.recordAssertionEvidence("Returning members can enter a password immediately", `remembered password form marked Last used=${form.elements.length}; Google and GitHub remain available; Next is absent`, form.elements.length === 1);
    expect(form.elements).toHaveLength(1);
    await member.screenshot();
  });

  await step("after: reloading sign-in in the same browser still remembers the password method", async () => {
    await member.reload();
    await member.see({ testId: "remembered-password-form" }, { timeoutMs: 60_000 });
    await member.see({ text: "Last used" });
    await member.see({ role: "textbox", label: /^password$/i });
    await member.notSee({ role: "button", label: "Next" });
    const cookie = await world.rememberedCookie();
    evidence.recordAssertionEvidence("The remembered method survives sign-out and a new document", `remembered cookie=${JSON.stringify(cookie)}; password and Last used are visible without Next`, cookie?.value === "password");
    expect(cookie?.value).toBe("password");
    await member.screenshot();
  });

  await step("the member can still choose Single sign-on to find an organization by email", async () => {
    await member.click({ role: "button", label: "Single sign-on" });
    await member.see({ role: "textbox", label: /^email$/i });
    await member.see({ role: "button", label: "Next" });
    await member.notSee({ role: "textbox", label: /^password$/i });
    await member.notSee({ text: "Last used" });
    const forms = await browser.dom('[data-testid="remembered-password-form"]');
    evidence.recordAssertionEvidence("Single sign-on retains the email-first organization discovery path", `remembered password forms=${forms.elements.length}; email and Next are visible`, forms.elements.length === 0);
    expect(forms.elements).toHaveLength(0);
    await member.screenshot();
  });

  await step("another fresh browser still starts email-first rather than inheriting the member's method", async () => {
    const newcomer = user.on(world.freshBrowser);
    await newcomer.reload();
    await newcomer.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 60_000 });
    await newcomer.see({ role: "button", label: "Next" });
    await newcomer.notSee({ role: "textbox", label: /^password$/i });
    await newcomer.notSee({ text: "Last used" });
    const forms = await probe.on(world.freshBrowser).dom('[data-testid="remembered-sign-in"]');
    evidence.recordAssertionEvidence("Remembered methods stay scoped to the browser that signed in", `fresh-browser remembered panels=${forms.elements.length}; email and Next are visible`, forms.elements.length === 0);
    expect(forms.elements).toHaveLength(0);
    await newcomer.screenshot();
  });
});
