import { expect } from "vitest";
import { test, attachSurface, evaluateOnSurface, eventually, screenshot } from "@openwork/testkit";
import { clickTarget, typeText, readDom } from "@openwork/cdp";
import { localHost } from "@openwork/hosts";
import { validate } from "@openwork/test-evidence";

test("enterprise sign-in exposes its existing manual handoff path", { timeout: 300_000 }, async ({ place, evidence }) => {
  const bootstrap = { baseUrl: "https://den.example.test", requireSignin: true, requireActivation: true };
  const host = place.host() ?? localHost();
  const handle = await host.spawnElectron("signin-code-discovery", {
    profile: "fresh", bootstrap,
    env: { OPENWORK_EVAL_CAPTURE_EXTERNAL_OPENS: "1", OPENWORK_DESKTOP_DISTRIBUTION: "enterprise" },
  });
  try {
    await using desktop = await attachSurface(handle);
    const text = await eventually(() => evaluateOnSurface(desktop, () => document.body.innerText), {
      within: 60_000, label: "activation form", until: (value) => value.includes("Workspace address"),
    });
    expect(text).toContain("Workspace address or sign-in code");
    expect(text).toContain("paste the full OpenWork link");
    expect(text).not.toContain("Confirm and finish sign-in");
    expect(text).not.toContain("Sign-in didn’t come back?");
    const geometry = await readDom(desktop, "#organization-server-input, #organization-server-hint");
    expect(geometry.elements).toHaveLength(2);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.elements.every((element) => element.rect.width > 0 && element.rect.height > 0)).toBe(true);
    await validate(await screenshot(desktop), [
      "The activation form shows Workspace address or sign-in code and a readable full-link helper without clipping or overlap.",
    ]);
    evidence.recordAssertionEvidence("The activation field names sign-in codes and explains the full-link requirement", "Label and associated helper visible; recovery action absent before browser sign-in; controls have healthy dimensions", true);

    await clickTarget(desktop, { label: "Workspace address or sign-in code" });
    await typeText(desktop, "https://den.example.test");
    await clickTarget(desktop, { testId: "organization-server-continue" });
    await eventually(() => evaluateOnSurface(desktop, () => document.body.innerText), {
      within: 10_000, label: "server confirmation", until: (value) => value.includes("Continue in browser"),
    });
    await clickTarget(desktop, { testId: "organization-server-confirm" });
    const waiting = await eventually(() => evaluateOnSurface(desktop, () => document.body.innerText), {
      within: 15_000, label: "browser-return recovery", until: (value) => value.includes("Sign-in didn’t come back?"),
    });
    expect(waiting).toContain("Finish signing in in your browser");
    await validate(await screenshot(desktop), [
      "The activation screen shows the readable Sign-in didn’t come back? Paste the code from the browser recovery action without clipping or overlap.",
    ]);
    await clickTarget(desktop, { role: "button", text: "Sign-in didn’t come back? Paste the code from the browser" });
    const focused = await evaluateOnSurface(desktop, () => {
      const input = document.getElementById("organization-server-input");
      return input instanceof HTMLInputElement && document.activeElement === input
        && input.selectionStart === 0 && input.selectionEnd === input.value.length;
    });
    expect(focused).toBe(true);
    await typeText(desktop, "openwork://den-auth?grant=fixture-one-time-grant&denBaseUrl=https%3A%2F%2Fden.example.test");
    await clickTarget(desktop, { testId: "organization-server-continue" });
    const confirmation = await eventually(() => evaluateOnSurface(desktop, () => document.body.innerText), {
      within: 10_000, label: "manual handoff confirmation", until: (value) => value.includes("Confirm and finish sign-in"),
    });
    expect(confirmation).toContain("https://den.example.test");
    expect(confirmation).not.toContain("Continue in browser");
    expect(confirmation).not.toContain("fixture-one-time-grant");
    await validate(await screenshot(desktop), [
      "The server confirmation shows den.example.test and Confirm and finish sign-in without displaying a grant or one-time code.",
    ]);
    evidence.recordAssertionEvidence("Browser-return recovery focuses and selects the existing field, and a pasted link reaches manual origin confirmation", "The recovery control selected the complete address; the pasted link offered Confirm and finish sign-in, not another browser launch; the grant was not rendered in confirmation", true);
  } finally {
    await host.disposeSurface(handle);
  }
});
