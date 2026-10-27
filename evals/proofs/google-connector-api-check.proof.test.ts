import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { googleConnectorApiCheck, VIEWPORT_HEIGHT } from "../worlds/google-connector-api-check.ts";

const test = spec.world(googleConnectorApiCheck, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an admin sees which Google APIs the connector needs and which are turned off", async ({ world, user, probe, step, evidence }) => {
  const rows = async () => {
    const found = await probe.dom("[data-api][data-status]");
    return found.elements.map((element) => element.text);
  };
  const status = async (api: string, value: string) => (await probe.dom(`[data-api="${api}"][data-status="${value}"]`)).elements.length === 1;
  // The Google APIs section ends the page: scroll to it and record that all of it is on screen.
  const showApis = async () => {
    await user.wheelAt({ x: 760, y: 700, deltaY: 4000 });
    // The page scrolls smoothly; read the position once it has come to rest.
    const section = await probe.eventually(async () => (await probe.dom('[data-testid="google-api-check"]')).elements[0], {
      within: 5_000,
      until: (found) => !!found && found.rect.top >= 0 && found.rect.bottom <= VIEWPORT_HEIGHT,
      label: "Google APIs section on screen",
    });
    const visible = !!section && section.rect.top >= 0 && section.rect.bottom <= VIEWPORT_HEIGHT;
    evidence.recordAssertionEvidence("The whole Google APIs section is on screen", `top=${section?.rect.top}px; bottom=${section?.rect.bottom}px; viewport=${VIEWPORT_HEIGHT}px`, visible);
    expect(visible).toBe(true);
  };

  await step("before: the connector's settings list its permissions and nothing about Google APIs is checked yet", async () => {
    await user.click({ testId: "connector-settings-toggle" });
    await user.see({ role: "heading", label: "What your AI can do" }, { timeoutMs: 60_000 });
    await user.see({ testId: "google-api-check-run" }, { text: "Check APIs" });
    const listed = await rows();
    const ok = listed.length === 0 && world.probes().length === 0;
    evidence.recordAssertionEvidence("Opening settings does not call Google", `API rows=${listed.length}; Google probes=${world.probes().length}`, ok);
    expect(ok).toBe(true);
    await showApis();
    await user.screenshot();
  });

  await step("after: Check APIs shows Docs and Sheets turned off in Google Cloud, each with Google's link to turn it on", async () => {
    await user.click({ testId: "google-api-check-run" });
    await user.see({ testId: "google-api-check-run" }, { text: "Check again", timeoutMs: 30_000 });
    const off = await status("docs", "disabled") && await status("sheets", "disabled");
    const on = await status("drive", "enabled") && await status("gmail", "enabled") && await status("calendar", "enabled");
    const links = (await probe.dom(`a[href="${world.enableUrl("docs")}"], a[href="${world.enableUrl("sheets")}"]`)).elements.length;
    const listed = await rows();
    const ok = off && on && links === 2 && listed.length === 5;
    evidence.recordAssertionEvidence("The five APIs these permissions need are listed; the two that are off link to Google Cloud", `rows=${listed.length}; Docs and Sheets off=${off}; Drive, Gmail and Calendar on=${on}; Turn on links=${links}`, ok);
    expect(ok).toBe(true);
    await showApis();
    await user.screenshot();
  });

  await step("after: once Docs and Sheets are turned on in Google Cloud, Check again shows every API on", async () => {
    world.turnOn("docs");
    world.turnOn("sheets");
    const before = world.probes().length;
    await user.click({ testId: "google-api-check-run" });
    await user.see({ role: "heading", label: "Google APIs" });
    const allOn = await probe.eventually(async () => ({
      docs: await status("docs", "enabled"),
      sheets: await status("sheets", "enabled"),
      off: (await probe.dom('[data-status="disabled"]')).elements.length,
    }), { within: 30_000, until: (value) => value.docs && value.sheets && value.off === 0, label: "every API on" });
    const reran = world.probes().length - before;
    const ok = allOn.docs && allOn.sheets && allOn.off === 0 && reran === 5;
    evidence.recordAssertionEvidence("Checking again reads Google's current answer", `Docs on=${allOn.docs}; Sheets on=${allOn.sheets}; still off=${allOn.off}; new probes=${reran}`, ok);
    expect(ok).toBe(true);
    await showApis();
    await user.screenshot();
  });
});
