import { expect } from "vitest";
import { spec, type Target } from "@openwork/testkit";
import { sidePanelAlignment } from "../worlds/side-panel-alignment.ts";

const test = spec.world(sidePanelAlignment, {
  resources: {
    surfaces: ["desktop"],
    services: ["den"],
    nativeReason: "The Browser rail and pane toggle share the Electron titlebar; the Browser control is absent on web.",
  },
});

const toggleSelector = '[data-session-header] button[aria-label="Open side panel"], [data-session-header] button[aria-label="Close side panel"]';
const signInSelector = '[data-session-header] button[aria-label="Sign in to OpenWork Cloud"]';

test("members and signed-out users keep the macOS pane toggle aligned above Browser and Files", async ({ world, user, probe, step, evidence }) => {
  for (const { app, signedIn } of [{ app: world.app, signedIn: true }, { app: world.signedOut, signedIn: false }]) {
    const person = user.on(app);
    const observe = probe.on(app);
    const persona = signedIn ? "a member" : "a signed-out user";
    const signIn: Target = { role: "button", label: "Sign in to OpenWork Cloud" };
    await person.click({ role: "button", label: "New session" });
    await person.see({ role: "button", label: "Browser" });
    if (signedIn) await person.notSee(signIn);
    else await person.see(signIn);

    for (const state of ["closed", "open", "closed again"]) {
      await step(`${persona} sees the toggle above its rail with the pane ${state}`, async () => {
        if (state === "open") await person.click({ role: "button", label: "Open side panel" });
        if (state === "closed again") await person.click({ role: "button", label: "Close side panel" });
        await person.see({ role: "button", label: state === "open" ? "Close side panel" : "Open side panel" });
        const closePanel: Target = { role: "button", label: "Close panel" };
        if (state === "open") await person.see(closePanel);
        else await person.notSee(closePanel);
        // Read the actual rendered controls, not CSS classes or a mocked layout.
        const rect = async (selector: string) => {
          const result = await observe.dom(selector);
          expect(result.elements).toHaveLength(1);
          const element = result.elements[0];
          if (!element || element.rect.width === 0) throw new Error(`Control is not visible: ${selector}`);
          return element.rect;
        };
        const toggle = await rect(toggleSelector);
        const browser = await rect('[data-chat-viewport] aside button[aria-label="Browser"]');
        const files = await rect('[data-chat-viewport] aside button[aria-label^="Files ("]');
        const auth = signedIn ? null : await rect(signInSelector);
        const centerX = (box: typeof toggle) => box.left + box.width / 2;
        const centerY = (box: typeof toggle) => box.top + box.height / 2;
        const browserOffset = centerX(toggle) - centerX(browser);
        const filesOffset = centerX(toggle) - centerX(files);
        const aligned = Math.abs(browserOffset) <= 0.5 && Math.abs(filesOffset) <= 0.5;
        const signInClear = auth === null || (auth.right <= toggle.left && Math.abs(centerY(auth) - centerY(toggle)) <= 0.5);
        const measurement = { persona, state, toggle, browser, files, auth, browserOffset, filesOffset };
        console.log("Pane alignment", JSON.stringify(measurement));
        evidence.recordAssertionEvidence(
          "The pane toggle stays above Browser and Files, with sign-in clear to its left",
          JSON.stringify(measurement),
          aligned && signInClear,
        );
        await person.hover("composer");
        await person.screenshot();
        expect.soft(browserOffset, `${persona}, ${state}: Browser center offset`).toBeCloseTo(0, 0);
        expect.soft(filesOffset, `${persona}, ${state}: Files center offset`).toBeCloseTo(0, 0);
        expect.soft(signInClear, `${persona}, ${state}: sign-in stays left of the toggle on the same row`).toBe(true);
      });
    }
  }
});
