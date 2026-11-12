import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { signedOutCloudPages } from "../worlds/signed-out-cloud-pages.ts";

const test = spec.world(signedOutCloudPages, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { commands: ["bun"] },
});
const WITHIN = 60_000;
const signIn = { role: "button", label: "Sign in to OpenWork Cloud" } as const;

test("a person who has not signed in finds Artifacts and Automations, and each asks them to sign in", async ({ world, user, probe, step, evidence }) => {
  // The page's whole request to sign in: its one line and its one action.
  const prompt = (testId: string) => probe.eventually(
    async () => (await probe.dom(`[data-testid="${testId}"]`)).elements.map(element => element.text).join(" "),
    { within: WITHIN, label: "the page's request to sign in", until: value => value.includes("Sign in to OpenWork Cloud") },
  );
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  await step("after: signed out, the sidebar lists Artifacts and Automations", async () => {
    await user.see({ role: "button", label: "Artifacts" }, { timeoutMs: WITHIN });
    await user.see({ role: "button", label: "Automations" });
    const entries = (await probe.dom('[aria-label="Artifacts"], [aria-label="Automations"]')).elements.map(element => element.text);
    expect(entries).toEqual(["Artifacts", "Automations"]);
    evidence.recordAssertionEvidence("Both pages are in the sidebar with no account", `sidebar: ${entries.join(", ")}`, entries.length === 2);
    await user.screenshot();
  });

  await step("after: Artifacts is one request to sign in, not an empty list", async () => {
    await user.click({ role: "button", label: "Artifacts" });
    const text = await prompt("dashboard-sign-in");
    const route = await probe.hash();
    expect(text).toContain("Sign in to see the artifacts you and your team build");
    expect(route).toBe("#/dashboard");
    evidence.recordAssertionEvidence("Artifacts says what signing in gives and offers it", `route=${route}; "${text}"`, route === "#/dashboard");
    await user.screenshot();
  });

  await step("after: Automations is one request to sign in, and offers nothing that needs an account", async () => {
    await user.click({ role: "button", label: "Automations" });
    const text = await prompt("automations-sign-in");
    await user.notSee({ role: "button", label: "New Automation" });
    const route = await probe.hash();
    expect(text).toContain("Sign in to schedule tasks that run on your desktop or in the cloud");
    expect(route).toBe("#/automations");
    evidence.recordAssertionEvidence("Automations says what signing in gives and offers it", `route=${route}; "${text}"; New Automation not offered`, route === "#/automations");
    await user.screenshot();
  });

  await step("neither page asked OpenWork Cloud for anything about an account", async () => {
    const requests = world.accountRequests();
    expect(requests).toEqual([]);
    evidence.recordAssertionEvidence("Signed out, the pages read no account data", `account requests=${requests.length}`, requests.length === 0);
  });

  await step("Sign in to OpenWork Cloud opens the account page where they sign in", async () => {
    await user.click(signIn);
    const route = await probe.eventually(() => probe.hash(), { within: WITHIN, label: "the account page", until: value => value.includes("/settings/cloud-account") });
    await user.see({ text: "Sign in to OpenWork Cloud" }, { timeoutMs: WITHIN });
    evidence.recordAssertionEvidence("The one action leads to sign-in", `route=${route}`, route.includes("/settings/cloud-account"));
    await user.screenshot();
  });
});
