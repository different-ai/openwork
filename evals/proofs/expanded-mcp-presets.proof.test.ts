import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { expandedMcpPresetsWorld } from "../worlds/expanded-mcp-presets.ts";

const test = spec.world(expandedMcpPresetsWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const CORE = ["github", "notion", "linear", "stripe", "sentry", "granola", "polar", "slack", "exa", "render", "context7"];
const EXPANDED = ["airtable", "amplitude", "cal", "canva", "figma", "fireflies", "huggingface", "honeycomb", "klaviyo", "lucid", "monday", "mural", "posthog", "semgrep", "tavily", "vercel"];
const rows = '[data-testid="connector-catalog"] [data-testid^="connector-picker-"]';

test("an admin sees more official MCP servers only while expandedMcpPresets is on", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const observed = probe.on(world.web);
  const catalogUrl = world.url("/dashboard/mcp-connections/new");
  const rowCount = async () => (await observed.dom(rows)).elements.length;

  await step("before: with the flag off, Add a connector lists only the original presets", async () => {
    await admin.see({ text: "Add a connector" }, { timeoutMs: 60_000 });
    await admin.see({ testId: "connector-picker-notion" }, { timeoutMs: 30_000 });
    await admin.notSee({ testId: "item-rows-skeleton" });
    const core = await Promise.all(CORE.map((id) => observed.dom(`[data-testid="connector-picker-${id}"]`)));
    const expanded = await Promise.all(EXPANDED.map((id) => observed.dom(`[data-testid="connector-picker-${id}"]`)));
    const ok = core.every((result) => result.elements.length === 1) && expanded.every((result) => result.elements.length === 0);
    evidence.recordAssertionEvidence("Flag off shows the 11 original presets and none of the new ones", `core present=${core.filter((result) => result.elements.length === 1).length}/11; new present=${expanded.filter((result) => result.elements.length > 0).length}/16; rows=${await rowCount()}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: with the flag on, the same page adds 16 reviewed servers with real brand marks", async () => {
    await world.setExpandedPresets(true);
    await admin.navigate(catalogUrl);
    await admin.see({ testId: "connector-picker-airtable" }, { timeoutMs: 60_000 });
    await admin.notSee({ testId: "item-rows-skeleton" });
    const core = await Promise.all(CORE.map((id) => observed.dom(`[data-testid="connector-picker-${id}"]`)));
    const expanded = await Promise.all(EXPANDED.map((id) => observed.dom(`[data-testid="connector-picker-${id}"]`)));
    const marks = await Promise.all(EXPANDED.map((id) => observed.dom(`[data-testid="connector-picker-${id}"] img`)));
    const ok = core.every((result) => result.elements.length === 1) && expanded.every((result) => result.elements.length === 1)
      && marks.every((result) => result.elements.length === 1);
    evidence.recordAssertionEvidence("Flag on keeps the originals and adds every reviewed server with an image mark", `core present=${core.filter((result) => result.elements.length === 1).length}/11; new present=${expanded.filter((result) => result.elements.length === 1).length}/16; new with image mark=${marks.filter((result) => result.elements.length === 1).length}/16`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("a name filter finds a new server", async () => {
    await admin.type({ placeholder: "Filter by name" }, "Hugging", { replace: true });
    await admin.see({ testId: "connector-picker-huggingface" });
    const visible = await observed.dom(rows);
    const ok = visible.elements.length === 1 && visible.elements[0].text.includes("Hugging Face");
    evidence.recordAssertionEvidence("Filtering by name narrows to the one matching new server", `rows=${visible.elements.length}; names=${visible.elements.map((entry) => entry.text.split("\n")[0]).join(" | ")}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("kill: turning the flag off hides the new servers again and keeps the originals", async () => {
    await world.setExpandedPresets(false);
    await admin.navigate(catalogUrl);
    await admin.see({ testId: "connector-picker-notion" }, { timeoutMs: 60_000 });
    await admin.notSee({ testId: "item-rows-skeleton" });
    const expanded = await Promise.all(EXPANDED.map((id) => observed.dom(`[data-testid="connector-picker-${id}"]`)));
    const core = await Promise.all(CORE.map((id) => observed.dom(`[data-testid="connector-picker-${id}"]`)));
    const ok = expanded.every((result) => result.elements.length === 0) && core.every((result) => result.elements.length === 1);
    evidence.recordAssertionEvidence("Flag off again removes only the new suggestions", `new present=${expanded.filter((result) => result.elements.length > 0).length}/16; core present=${core.filter((result) => result.elements.length === 1).length}/11`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });
});
