import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { coworkPluginImport } from "../worlds/cowork-plugin-import.ts";

const test = spec.world(coworkPluginImport, { needs: { commands: ["bun"] }, timeout: 300_000 });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Preview = { components: { type: string; name: string }[]; warnings: string[] };

function readPreview(body: unknown): Preview {
  const preview = record(body) && record(body.preview) ? body.preview : null;
  if (!preview || !Array.isArray(preview.components) || !Array.isArray(preview.warnings)) {
    throw new Error(`no preview in ${JSON.stringify(body).slice(0, 300)}`);
  }
  return {
    components: preview.components.filter(record).map((item) => ({ type: String(item.type), name: String(item.name) })),
    warnings: preview.warnings.map(String),
  };
}

// Cowork's productivity plugin leaves Gmail and Google Calendar blank for the
// person to pick a provider, and its start skill copies a dashboard from
// ${CLAUDE_PLUGIN_ROOT}. The preview used to list Gmail and Calendar as
// installable, install dropped them without a word, and nothing said the
// start skill would miss its dashboard.
test("a person previewing a Cowork plugin sees what will not carry over before installing", async ({ world, step, evidence }) => {
  let preview: Preview = { components: [], warnings: [] };

  await step("given the productivity plugin from a Cowork marketplace", async () => {
    const result = await world.api("POST", "/claude-plugins", { url: world.repoUrl("productivity"), dryRun: true });
    expect(result.status).toBe(200);
    preview = readPreview(result.body);
    evidence.recordAssertionEvidence(
      "preview loaded",
      `${preview.components.length} components: ${preview.components.map((item) => `${item.type}:${item.name}`).join(", ")}`,
      true,
    );
  });

  await step("then the preview lists only connectors OpenWork can install", async () => {
    const servers = preview.components.filter((item) => item.type === "mcp").map((item) => item.name).sort();
    evidence.recordAssertionEvidence("connectors in the preview", servers.join(", "), !servers.includes("gmail"));
    expect(servers).toEqual(["notion", "slack"]);
  });

  await step("and it says Gmail and Google Calendar need setting up in OpenWork", async () => {
    const warning = preview.warnings.find((text) => text.includes("\"gmail\""));
    evidence.recordAssertionEvidence("blank connectors are named", warning ?? `no warning among: ${preview.warnings.join(" | ")}`, Boolean(warning));
    expect(warning).toContain("\"google calendar\"");
    expect(warning).toContain("Connections");
  });

  await step("and it says the start skill depends on plugin files that are not installed", async () => {
    const warning = preview.warnings.find((text) => text.includes("CLAUDE_PLUGIN_ROOT"));
    evidence.recordAssertionEvidence("plugin-file reference is named", warning ?? `no warning among: ${preview.warnings.join(" | ")}`, Boolean(warning));
    expect(warning).toContain("\"start\"");
    expect(warning).not.toContain("\"task-management\"");
  });

  await step("after: installing matches the preview exactly", async () => {
    const result = await world.api("POST", "/claude-plugins", { url: world.repoUrl("productivity") });
    expect(result.status).toBe(200);
    const servers = await world.api("GET", "/mcp");
    const names = record(servers.body) && Array.isArray(servers.body.items)
      ? servers.body.items.filter(record).map((item) => String(item.name)).sort()
      : [];
    const previewed = preview.components.filter((item) => item.type === "mcp").map((item) => item.name).sort();
    evidence.recordAssertionEvidence("installed connectors = previewed connectors", `installed: ${names.join(", ")}; previewed: ${previewed.join(", ")}`, JSON.stringify(names) === JSON.stringify(previewed));
    expect(names).toEqual(previewed);
  });
});
