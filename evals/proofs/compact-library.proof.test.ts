import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { compactLibraryWorld } from "../worlds/compact-library.ts";

const test = spec.world(compactLibraryWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

const rows = '[data-testid="library-screen"] [data-library-item]';
const skillRows = `${rows}[data-library-kind="plugin"]`;

test("a Library owner scans a grouped collection, opens a skill and sees the sign-in tab", async ({ world, user, probe, step, evidence }) => {
  const library = user.on(world.web);
  const observed = probe.on(world.web);

  await step("the Library groups items by kind, puts sign-in first and aligns every column", async () => {
    await library.see({ testId: "library-compact-toolbar" }, { timeoutMs: 60_000 });
    await library.see({ text: "Daily brief" });
    await library.see({ text: world.descriptions[0] });
    await library.see({ placeholder: "Filter by name" });
    await library.notSee({ testId: "item-rows-skeleton" });
    const sections = await observed.dom('[data-testid^="library-section-"]');
    const attention = await observed.dom('[data-testid="library-section-attention"] [data-library-item]');
    const skills = await observed.dom('[data-testid="library-section-skills"] [data-library-item]');
    const descriptions = await observed.dom(`${rows} [data-library-description]`);
    const actions = await observed.dom(`${rows} [data-item-action]`);
    const ready = await observed.dom('[data-library-item] [data-item-status]');
    const starts = new Set(descriptions.elements.filter((entry) => entry.text).map((entry) => Math.round(entry.rect.left)));
    const ends = new Set(actions.elements.map((entry) => Math.round(entry.rect.left + entry.rect.width)));
    const ok = sections.elements.length >= 3 && sections.elements[0].text.startsWith("Needs your sign-in")
      && attention.elements.length === 1 && attention.elements[0].text.includes("Personal notes")
      && skills.elements.length === 10 && !skills.elements.some((row) => /\bSkill\b/.test(row.text))
      && starts.size === 1 && ends.size === 1
      && !ready.elements.some((entry) => entry.text === "Ready");
    evidence.recordAssertionEvidence("Grouped sections with aligned description and action columns", `sections=${sections.elements.map((entry) => entry.text.split("\n")[0]).join(" | ")}; attention=${attention.elements.map((entry) => entry.text).join(" | ")}; skills=${skills.elements.length}; description starts=${[...starts].join(",")}; action ends=${[...ends].join(",")}`, ok);
    expect(ok).toBe(true);
    await library.screenshot();
  });

  await step("the Skills filter and a name search keep only the matching skill", async () => {
    await library.click({ role: "tab", label: "Skills" });
    await library.type({ placeholder: "Filter by name" }, "Daily", { replace: true });
    await library.see({ text: "Daily brief" });
    const matches = await observed.dom(rows);
    const ok = matches.elements.length === 1 && matches.elements[0].text.includes("Daily brief") && !matches.elements.some((entry) => entry.text.includes("Team wiki"));
    evidence.recordAssertionEvidence("Kind and name filters compose without including connectors", `matching rows=${matches.elements.length}; names=${matches.elements.map((entry) => entry.text).join(" | ")}`, ok);
    expect(ok).toBe(true);
    await library.screenshot();
  });

  await step("a name with no matches shows an explicit empty result without stale rows", async () => {
    await library.type({ placeholder: "Filter by name" }, "No such synthetic item", { replace: true });
    await library.see({ text: "Nothing matches." });
    const matches = await observed.dom(rows);
    evidence.recordAssertionEvidence("An unmatched name removes every previous result", `matching rows=${matches.elements.length}`, matches.elements.length === 0);
    expect(matches.elements).toHaveLength(0);
    await library.screenshot();
  });

  await step("a skill previews its complete instructions inline", async () => {
    await library.type({ placeholder: "Filter by name" }, "", { replace: true });
    await library.click({ role: "tab", label: "All" });
    await library.click({ role: "link", label: /^Daily brief/ });
    await library.see({ testId: "whats-inside" }, { timeoutMs: 30_000 });
    await library.click({ text: /^Daily brief instructions$/ });
    const bodies = (await observed.dom("details[data-skill-preview][open] pre")).elements.map(element => element.text);
    const text = bodies.join("\n");
    const ok = text.includes("Read the **supplied notes**") && text.includes("Keep `names` and dates as written.") && text.includes("Do not invent facts.");
    evidence.recordAssertionEvidence("The default skill disclosure contains the full instructions", text, ok);
    expect(ok).toBe(true);
    await library.screenshot();
  });

  await step("a narrow Library keeps its rows and toolbar inside the viewport", async () => {
    await library.navigate(world.url("/dashboard/library"));
    await probe.eventually(() => observed.dom(rows), { within: 30_000, label: "the full collection returns", until: result => result.elements.length === 12 });
    await library.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await library.see({ text: "Daily brief" });
    const layout = await observed.dom(`${rows}, [data-testid="library-compact-toolbar"]`);
    const ok = layout.elements.length >= 9 && layout.documentWidth <= layout.viewportWidth
      && layout.elements.every((entry) => entry.rect.left >= 0 && entry.rect.left + entry.rect.width <= layout.viewportWidth + 1);
    evidence.recordAssertionEvidence("The populated compact Library fits a 390px screen", `document=${layout.documentWidth}px; viewport=${layout.viewportWidth}px; rows and toolbar=${layout.elements.length}`, ok);
    expect(ok).toBe(true);
    await library.screenshot();
  });

  await step("even a 320px Library leaves room to identify each item", async () => {
    await library.resizeViewport({ width: 320, height: 760, deviceScaleFactor: 1 });
    await library.see({ text: "Daily brief" });
    const names = await observed.dom(`${rows} [data-library-name]`);
    const ok = names.elements.length === 12 && names.documentWidth <= names.viewportWidth
      && names.elements.every((entry) => entry.rect.width >= 72);
    evidence.recordAssertionEvidence("Names retain a readable width on the smallest supported viewport", `document=${names.documentWidth}px; viewport=${names.viewportWidth}px; name widths=${names.elements.map((entry) => entry.rect.width).join(",")}`, ok);
    expect(ok).toBe(true);
    await library.screenshot();
  });

  await step("the connector sign-in tab shows both logos, one state line and a calm failure", async () => {
    await library.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await library.navigate(world.url("/connect/oauth?connection=synthetic&name=Personal%20notes"));
    await library.see({ testId: "connect-handoff-screen" }, { timeoutMs: 30_000 });
    await library.see({ text: "Opening Personal notes" });
    await library.see({ text: "Keep this tab open to finish signing in." });
    await library.screenshot();
    const failure = encodeURIComponent(JSON.stringify({
      message: "Personal notes rejected the sign-in request.",
      details: { httpStatus: 400, responseJson: "{}", diagnosticReference: "synthetic_ref_01", retryable: true, actionOwner: "member" },
    }));
    await library.navigate(world.url(`/connect/oauth?connection=synthetic&name=Personal%20notes&outcome=failed&failure=${failure}`));
    await library.see({ text: "Couldn't start the Personal notes sign-in" }, { timeoutMs: 30_000 });
    await library.see({ text: "synthetic_ref_01" });
    await library.see({ role: "link", label: "Back to your connections" });
    const details = await observed.dom('[data-testid="connect-handoff-screen"] details:not([open])');
    const ok = details.elements.length === 1;
    evidence.recordAssertionEvidence("Failure keeps diagnostics collapsed and offers a way back", `collapsed technical details=${details.elements.length}`, ok);
    expect(ok).toBe(true);
    await library.screenshot();
  });
});
