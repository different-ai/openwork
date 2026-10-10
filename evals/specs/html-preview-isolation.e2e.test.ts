import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { escapeMarker, htmlPreviewIsolationWorld, untrustedHtmlName, untrustedHtmlPath } from "../worlds/html-preview-isolation.ts";

const test = spec.world(htmlPreviewIsolationWorld, {
  resources: {
    surfaces: ["desktop"],
    services: [],
    nativeReason: "The desktop bridge a preview must not reach exists only in the Electron window.",
  },
});

test("a member previews an untrusted HTML file and its script stays inside the preview", async ({ world, user, probe, step, evidence }) => {
  await step("given the app window exposes the desktop bridge", async () => {
    await user.see("Select tab: overflow-tab-12.md");
    const bridge = await world.hostBridge();
    evidence.recordAssertionEvidence("The app window has the desktop bridge", `typeof window.__OPENWORK_ELECTRON__.invokeDesktop → ${String(bridge)}`, bridge === "function");
    expect(bridge).toBe("function");
  });

  await step("when the member opens the workspace HTML file", async () => {
    await user.click({ role: "button", label: "Show workspace files" });
    await user.see({ placeholder: "Search files" }, { timeoutMs: 30_000 });
    await user.type({ placeholder: "Search files" }, untrustedHtmlName);
    await user.press("Tab");
    await user.press("Tab");
    await user.press("Enter");
    await user.see(`Select tab: ${untrustedHtmlName}`, { timeoutMs: 30_000 });
    const reports = await probe.eventually(() => world.previewReports(), {
      within: 20_000,
      label: "the previewed page's script reports back",
      until: (value) => value.length > 0,
    });
    const [report] = reports;
    evidence.recordAssertionEvidence("The page's own script ran in the preview (witness)", `${untrustedHtmlPath} posted ${reports.length} report(s); ownScript=${String(report?.ownScript)}; sender origin ${report?.origin}`, report?.ownScript === true);
    expect(report?.ownScript).toBe(true);
    await user.screenshot();
  });

  await step("after: the preview cannot reach the desktop bridge", async () => {
    await user.see(`Select tab: ${untrustedHtmlName}`);
    const [report] = await world.previewReports();
    const blocked = report?.bridge.startsWith("blocked") === true && report.origin === "null";
    evidence.recordAssertionEvidence("The preview cannot reach the desktop bridge", `parent.__OPENWORK_ELECTRON__ → ${report?.bridge}; preview origin ${report?.origin}`, blocked);
    expect(report?.origin).toBe("null");
    expect(report?.bridge).toMatch(/^blocked/);
  });

  await step("after: the preview cannot read or change the app window", async () => {
    await user.see(`Select tab: ${untrustedHtmlName}`);
    const [report] = await world.previewReports();
    const escaped = (await probe.dom(`[${escapeMarker}]`)).elements.length;
    evidence.recordAssertionEvidence("The preview cannot read or change the app window", `parent.document → ${report?.parentDocument}; app elements marked by the page: ${escaped}; page storage → ${report?.storage}`, report?.parentDocument.startsWith("blocked") === true && escaped === 0);
    expect(report?.parentDocument).toMatch(/^blocked/);
    expect(escaped).toBe(0);
    await user.screenshot();
  });
});
