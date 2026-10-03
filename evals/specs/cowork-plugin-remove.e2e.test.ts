import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { coworkPluginImport } from "../worlds/cowork-plugin-import.ts";
import type { CoworkPluginImportWorld } from "../worlds/cowork-plugin-import.ts";

const test = spec.world(coworkPluginImport, { needs: { commands: ["bun"] }, timeout: 300_000 });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mcpNames(world: CoworkPluginImportWorld): Promise<string[]> {
  const result = await world.api("GET", "/mcp");
  expect(result.status).toBe(200);
  const items = record(result.body) && Array.isArray(result.body.items) ? result.body.items.filter(record) : [];
  return items.flatMap((item) => (typeof item.name === "string" ? [item.name] : [])).sort();
}

function installedPluginId(result: { body: unknown }): string {
  const item = record(result.body) && record(result.body.item) ? result.body.item : null;
  if (!item || typeof item.pluginId !== "string") throw new Error(`install returned no plugin: ${JSON.stringify(result.body).slice(0, 300)}`);
  return item.pluginId;
}

const SALES_ONLY = ["close", "gong", "hubspot", "salesforce", "zoominfo"];
const SHARED = ["notion", "slack"];

// Cowork plugins overlap: productivity and sales both bring Slack and Notion,
// and sales adds five CRM and call-recording servers of its own. Removing a
// plugin used to drop only one of its servers (the removals overwrote each
// other) and would have taken shared servers away from the plugin that stays.
test("a person who imported two overlapping Cowork plugins removes one and keeps the other working", async ({ world, step, evidence }) => {
  let salesId = "";
  let productivityId = "";

  await step("given productivity and sales imported from the same Cowork marketplace", async () => {
    const productivity = await world.api("POST", "/claude-plugins", { url: world.repoUrl("productivity") });
    const sales = await world.api("POST", "/claude-plugins", { url: world.repoUrl("sales") });
    expect(productivity.status).toBe(200);
    expect(sales.status).toBe(200);
    productivityId = installedPluginId(productivity);
    salesId = installedPluginId(sales);
    const names = await mcpNames(world);
    for (const name of [...SHARED, ...SALES_ONLY]) expect(names).toContain(name);
    const skills = await world.installedFiles("skills");
    evidence.recordAssertionEvidence(
      "both plugins are installed",
      `servers: ${names.join(", ")}; skill folders: ${[...new Set(skills.map((path) => path.split("/")[0]))].join(", ")}`,
      true,
    );
  });

  await step("when the person removes sales", async () => {
    const removed = await world.api("DELETE", `/cloud-plugins/${encodeURIComponent(salesId)}`);
    evidence.recordAssertionEvidence("remove sales", `DELETE → ${removed.status}`, removed.status === 200);
    expect(removed.status).toBe(200);
  });

  await step("then every server only sales used is gone", async () => {
    const names = await mcpNames(world);
    const leftover = SALES_ONLY.filter((name) => names.includes(name));
    evidence.recordAssertionEvidence(
      "sales-only servers removed",
      leftover.length ? `still configured: ${leftover.join(", ")}` : `none of ${SALES_ONLY.join(", ")} remain; servers now: ${names.join(", ")}`,
      leftover.length === 0,
    );
    expect(leftover).toEqual([]);
  });

  await step("and productivity keeps Slack and Notion and its skills", async () => {
    const names = await mcpNames(world);
    const skills = await world.installedFiles("skills");
    const salesLeft = skills.filter((path) => path.startsWith("sales-plugin"));
    evidence.recordAssertionEvidence(
      "productivity still works",
      `shared servers: ${SHARED.filter((name) => names.includes(name)).join(", ")}; sales files left: ${salesLeft.length ? salesLeft.join(", ") : "none"}; productivity skills: ${skills.filter((path) => path.startsWith("productivity-plugin")).length}`,
      SHARED.every((name) => names.includes(name)) && salesLeft.length === 0,
    );
    for (const name of SHARED) expect(names).toContain(name);
    expect(salesLeft).toEqual([]);
    expect(skills.some((path) => path.startsWith("productivity-plugin/start/"))).toBe(true);
  });

  await step("after: removing productivity too leaves no plugin servers or folders behind", async () => {
    const removed = await world.api("DELETE", `/cloud-plugins/${encodeURIComponent(productivityId)}`);
    expect(removed.status).toBe(200);
    const names = await mcpNames(world);
    const skills = await world.installedFiles("skills");
    evidence.recordAssertionEvidence(
      "workspace is clean again",
      `servers: ${names.length ? names.join(", ") : "none"}; skill folders: ${skills.length ? skills.join(", ") : "none"}`,
      names.length === 0 && skills.length === 0,
    );
    expect(names).toEqual([]);
    expect(skills).toEqual([]);
  });
});
