import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denPluginDirectoryWorld } from "../worlds/den-plugin-directory.ts";

const test = spec.world(denPluginDirectoryWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const rows = '[data-testid="admin-plugins"] [data-plugin-row]';

test("an owner scrolls a long plugin directory, retries a failed page and filters from the bottom", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const observed = probe.on(world.web);
  const wheel = async () => {
    const viewport = await observed.dom('main main');
    await owner.wheelAt({ x: Math.min(viewport.viewportWidth - 40, 900), y: 800, deltaY: 700 });
  };

  await step("the first page is compact and only the rows near the viewport are drawn", async () => {
    await owner.navigate(world.url("/dashboard/plugins"));
    await owner.see({ testId: "plugin-directory-toolbar" }, { timeoutMs: 60_000 });
    const result = await probe.eventually(() => observed.dom(rows), { within: 30_000, label: "the first directory window appears", until: value => value.elements.length > 0 });
    const ok = result.elements.length < 40 && result.elements.every(row => row.rect.height >= 48 && row.rect.height <= 50);
    evidence.recordAssertionEvidence("A 140-item directory draws a bounded initial window", `drawn=${result.elements.length}; heights=${[...new Set(result.elements.map(row => row.rect.height))].join(",")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("a failed next page stays recoverable instead of retrying forever", async () => {
    for (let page = 0; page < 6; page++) await wheel();
    await owner.see({ text: "More plugins did not load. Use Load more to try again." }, { timeoutMs: 30_000 });
    await wheel();
    const attempts = world.attempts();
    const ok = attempts.rejected === 2 && attempts.cursorRequests === 2;
    evidence.recordAssertionEvidence("One page failure exhausts only the configured single retry", JSON.stringify(attempts), ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("the owner retries and reaches items beyond several scroll windows", async () => {
    world.recoverNextPage();
    await owner.click({ role: "button", label: "Load more plugins" });
    await probe.eventually(() => observed.dom('[data-testid="admin-plugins"] [role="alert"]'), {
      within: 30_000, label: "the retried directory page recovers", until: result => !result.elements.some(entry => entry.text.includes("More plugins did not load")),
    });
    let reached = false;
    for (let page = 0; page < 16; page++) {
      await wheel();
      const window = await observed.dom(rows);
      reached = window.elements.some(row => row.text.includes("Directory item 001"));
      if (reached) break;
    }
    await owner.see({ text: "Directory item 001" }, { timeoutMs: 30_000 });
    const attempts = world.attempts();
    const ok = reached && attempts.cursorRequests >= 3;
    evidence.recordAssertionEvidence("The last item is reachable after explicit retry", JSON.stringify({ reached, ...attempts }), ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("a name filter resets the deep directory without an empty window", async () => {
    await owner.type({ placeholder: "Filter by name" }, "Directory item 071", { replace: true });
    await owner.see({ text: "Directory item 071" });
    const result = await probe.eventually(() => observed.dom(rows), { within: 15_000, label: "filtering leaves the one matching plugin", until: value => value.elements.length === 1 && value.elements[0].text.includes("Directory item 071") });
    const ok = result.elements.length === 1 && result.elements[0].rect.top >= 0 && result.elements[0].rect.top < 900;
    evidence.recordAssertionEvidence("The filtered plugin appears inside the viewport", `rows=${result.elements.length}; top=${result.elements[0]?.rect.top}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
    await owner.click({ role: "button", label: "More for Directory item 071" });
    await owner.see({ role: "menuitem", label: "Open" });
    await owner.press("Escape");
    await owner.click({ role: "link", label: /Directory item 071/ });
    await owner.see({ testId: "plugin-page" });
  });
});
