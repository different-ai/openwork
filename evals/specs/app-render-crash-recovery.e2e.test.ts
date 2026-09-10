import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { renderCrashWorld } from "../worlds/first-run.ts";

const test = spec.world(renderCrashWorld);

// Thrown by the dev-only eval hook. The message quotes a sign-in URL whose
// query string carries a grant: the recovery screen and the copied report must
// keep the path but never the query value.
const SECRET = "eval-secret-grant-4242";
const THROWN = `Local context is missing (eval render throw) after https://app.openworklabs.com/signin?code=${SECRET}`;
const MESSAGE = "Local context is missing (eval render throw) after https://app.openworklabs.com/signin";
const heading = { text: /OpenWork hit an unexpected error/ };

test("a render throw shows a recovery screen with the error instead of a blank window", async ({ world, user, agent, probe, step }) => {
  await step("the app is healthy and shows no recovery screen", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    expect((await probe.text()).trim().length).toBeGreaterThan(40);
    await user.notSee(heading);
  });

  await step("a throw during render lands on the recovery screen, not an empty window", async () => {
    await agent.run("eval.app.render_throw", { message: THROWN });
    await user.see(heading, { timeoutMs: 15_000 });
    await user.see({ role: "button", label: /^reload$/i });
    await user.see({ role: "button", label: /technical details/i });
    // Progressive disclosure: the raw payload waits behind the toggle.
    await user.notSee({ text: MESSAGE });
    await user.notSee({ text: /at BrandThemeControlActions/ });
    await user.notSee({ role: "button", label: /copy details/i });
    await user.screenshot();
  });

  await step("technical details reveal the redacted message, stack and reporting actions on demand", async () => {
    await user.click({ role: "button", label: /technical details/i });
    await user.see({ text: MESSAGE });
    // The URL keeps its path for diagnosis; the grant in its query never shows
    // anywhere on the page, message or stack.
    expect(await probe.has("https://app.openworklabs.com/signin")).toBe(true);
    expect(await probe.has(SECRET)).toBe(false);
    // The stack names the throwing component, so the failure is reportable.
    await user.see({ text: /at BrandThemeControlActions/ });
    await user.see({ role: "button", label: /copy details/i });
    await user.see({ role: "button", label: /open logs folder/i });
    await user.screenshot();
  });

  await step("copy puts the redacted message, stack, app version and flavor on the clipboard", async () => {
    await user.click({ role: "button", label: /copy details/i });
    await user.see({ role: "button", label: /^copied$/i });
    const clipboard = await probe.eventually(() => world.readClipboard(), {
      within: 5_000,
      label: "crash report on the clipboard",
      until: (value) => typeof value === "string" && value.includes(MESSAGE),
    });
    const [header, message, stack] = clipboard.split("\n\n");
    expect(header).toMatch(/^OpenWork \S+ \(desktop, (public|enterprise)\)$/);
    expect(message).toBe(MESSAGE);
    expect(stack).toMatch(/at BrandThemeControlActions/);
    expect(clipboard).toContain("https://app.openworklabs.com/signin");
    expect(clipboard).not.toContain(SECRET);
  });

  await step("reload brings the app back", async () => {
    const route = await probe.hash();
    await user.click({ role: "button", label: /^reload$/i });
    await probe.eventually(() => probe.text(), {
      within: 120_000,
      label: "app content after reload",
      until: (text) => text.trim().length > 40 && !/OpenWork hit an unexpected error/.test(text),
    });
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    expect(await probe.hash()).toBe(route);
    await user.notSee(heading);
  });
});
