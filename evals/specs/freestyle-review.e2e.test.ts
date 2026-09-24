import { expect } from "vitest";
import { spec, type Target } from "@openwork/testkit";
import { reviewBrowserWorld } from "../worlds/evidence-review.ts";

const test = spec.world(reviewBrowserWorld, {
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { placement: "local", commands: ["git"] },
});

const choices = [
  { value: "app-web", label: "OpenWork web" },
  { value: "desktop", label: "Desktop only (signed out)" },
  { value: "acme-web", label: "ACME web (full stack)" },
  { value: "acme-desktop", label: "ACME desktop (full stack)" },
];

const picker = { role: "combobox", label: "Preview world" } satisfies Target;
const disconnectedMessage = "Freestyle is not connected. The review app owner can connect it.";

test("a reviewer can choose a signed-out desktop without mistaking it for an ACME full-stack sandbox", async ({ world, user, probe, step, evidence }) => {
  await step("before: the reviewer sees a web preview choice and an honest missing-connection state", async () => {
    const page = await fetch(`${world.baseUrl}/r/${world.passed}`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("__openwork_launch?token=");
    await user.navigate(`${world.baseUrl}/r/${world.passed}`);
    await user.click({ role: "button", text: "Show sandbox" });
    await user.see(picker, { value: "app-web", editable: true });
    await user.see({ text: disconnectedMessage });
    await user.see({ role: "button", text: "Launch in Freestyle" });
    expect((await probe.dom("select[aria-label='Preview world']")).elements).toHaveLength(1);
    expect((await probe.dom("select[aria-label='Preview world'] option")).elements.map(({ text }) => text)).toEqual(choices.map(({ label }) => label));
    for (const choice of choices) {
      expect((await probe.dom(`select[aria-label='Preview world'] option[value='${choice.value}']`)).elements.map(({ text }) => text)).toEqual([choice.label]);
    }
    expect((await probe.dom(".preview-launch button:disabled")).elements.map(({ text }) => text)).toEqual(["Launch in Freestyle"]);
    expect((await probe.dom(".preview-launch details[open]")).elements).toHaveLength(0);
    await user.notSee({ role: "link", text: "Open desktop" });
    await user.notSee({ role: "link", text: "Open sandbox" });
    evidence.recordAssertionEvidence(
      "The reviewer can choose a scope without being promised an available sandbox",
      "Production review HTTP 200; one native selector offers OpenWork web, Desktop only (signed out), ACME web (full stack), and ACME desktop (full stack). Launch is disabled, the missing connection names the review app owner, and no sandbox access link is present.",
      true,
    );
    await user.screenshot();
  });

  await step("the reviewer chooses Desktop only (signed out) with the existing world selector", async () => {
    await user.click(picker);
    await user.press("Home");
    await user.press("ArrowDown");
    await user.press("Enter");
    await user.see(picker, { value: "desktop" });
    await user.see({ text: disconnectedMessage });
    expect((await probe.dom(".preview-launch a, .preview-launch section[aria-label='Your connection details']")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence(
      "Choosing Desktop only does not open or display a web sandbox",
      "The native selector changed from app-web to desktop through keyboard input. No access link or connection details appeared; the review still reports that Freestyle is not connected.",
      true,
    );
    await user.screenshot();
  });

  await step("after: the signed-out desktop scope excludes the full stack and a separate web preview", async () => {
    await user.click({ text: "Sandbox details" });
    await user.see(picker, { value: "desktop" });
    const scope = { text: /^OpenWork web runs the OpenWork web app and its local engine\./ };
    await user.see(scope);
    const details = (await probe.dom(".preview-launch details[open] p")).elements.map(({ text }) => text).join("\n");
    expect(details).toContain("Desktop only opens the real desktop app from this commit with a fresh, signed-out profile");
    expect(details).toContain("no Den, databases, AI Gateway, demo accounts, or separate web preview");
    expect(details).toContain("Its local engine and internal renderer belong to the desktop app");
    expect(details).toContain("ACME web and ACME desktop keep the full stack with demo accounts and a simulated model upstream");
    expect(details).toContain("Sandboxes expire after two hours; work is not saved");
    await user.see({ text: disconnectedMessage });
    expect((await probe.dom(".preview-launch button:disabled")).elements.map(({ text }) => text)).toEqual(["Launch in Freestyle"]);
    evidence.recordAssertionEvidence(
      "Desktop only explains its signed-out scope before any launch",
      `${details}\nObserved on the production review page with desktop selected and Launch disabled. This is scope-copy evidence, not proof that a VM has booted or that its services are absent.`,
      true,
    );
    await user.screenshot();
  });

  await step("the reviewer can still choose either ACME full-stack preview", async () => {
    await user.click(picker);
    await user.press("Home");
    await user.press("ArrowDown");
    await user.press("ArrowDown");
    await user.press("Enter");
    await user.see(picker, { value: "acme-web" });
    await user.click(picker);
    await user.press("End");
    await user.press("Enter");
    await user.see(picker, { value: "acme-desktop" });
    await user.see({ text: disconnectedMessage });
    expect((await probe.dom(".preview-launch a, .preview-launch section[aria-label='Your connection details']")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence(
      "Both ACME full-stack choices remain selectable without exposing access",
      "The same native selector accepts acme-web and then acme-desktop. Neither selection creates a sandbox link or connection details while Freestyle is disconnected; successful launch routing and existing-session clearing are outside this no-key journey.",
      true,
    );
    await user.screenshot();
  });

  await step("a missing connection or a third-party origin cannot launch any preview", async () => {
    await user.see({ text: disconnectedMessage });
    const endpoint = `${world.baseUrl}/r/${world.passed}/launch`;
    const outcomes: string[] = [];
    for (const requestedWorld of ["app-web", "desktop", "acme-web"]) {
      const disconnected = await fetch(endpoint, {
        method: "POST",
        headers: { origin: world.baseUrl, "content-type": "application/json" },
        body: JSON.stringify({ world: requestedWorld }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(disconnected.status).toBe(503);
      expect(disconnected.headers.get("cache-control")).toContain("no-store");
      expect(await disconnected.json()).toEqual({ error: "Freestyle is not connected. The review app owner can configure it." });
      const crossSite = await fetch(endpoint, {
        method: "POST",
        headers: { origin: "https://unrelated.example", "content-type": "application/json" },
        body: JSON.stringify({ world: requestedWorld }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(crossSite.status).toBe(403);
      expect(crossSite.headers.get("cache-control")).toContain("no-store");
      expect(await crossSite.json()).toEqual({ error: "Launch the sandbox from its review page." });
      outcomes.push(`${requestedWorld}: same-origin ${disconnected.status}, cross-site ${crossSite.status}`);
    }
    await user.notSee({ role: "link", text: "Open desktop" });
    await user.notSee({ role: "link", text: "Open sandbox" });
    evidence.recordAssertionEvidence(
      "Unavailable and cross-site launches cannot allocate a sandbox",
      `${outcomes.join("; ")}. All six responses are no-store and contain only the expected actionable error. The production fixture clears FREESTYLE_API_KEY; this journey uses no provider credentials or paid VM and does not verify a live desktop runtime.`,
      true,
    );
  });
});
