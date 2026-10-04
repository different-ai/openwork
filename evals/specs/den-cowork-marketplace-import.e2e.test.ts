import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord, records } from "../worlds/library.ts";
import { COWORK_FIXTURE, denCoworkMarketplace } from "../worlds/den-cowork-marketplace.ts";

const test = spec.world(denCoworkMarketplace, { timeout: 900_000, resources: { surfaces: [], services: ["den"] } });

// A reused Daytona Den keeps earlier runs' plugins; each run imports under its own name.
const PLUGIN_NAME = `Productivity ${Date.now().toString(36)}`;
const SKILL_FILES = Object.keys(COWORK_FIXTURE.files).filter((path) => path.endsWith("/SKILL.md"));

test("an admin's agent imports a Cowork marketplace into the organization without exhausting GitHub", async ({ world, step, evidence }) => {
  const callTool = world.callTool;

  await step("given an agent with the organization's OpenWork MCP finds the import tools by asking", async () => {
    const { json } = await callTool("search_capabilities", { query: "import plugin github" });
    const names = records(isRecord(json) ? json.matches : []).map((match) => String(match.name));
    evidence.recordAssertionEvidence("capabilities found", names.slice(0, 5).join(", "), names.includes("postPluginsImportMcpsFromGithubUrlPreview"));
    expect(names).toContain("postPluginsImportMcpsFromGithubUrlPreview");
  });

  await step("when the agent previews the whole marketplace link", async () => {
    const { isError, json } = await callTool("execute_capability", {
      name: "postPluginsImportMcpsFromGithubUrlPreview",
      body: { githubUrl: world.repoUrl() },
    });
    evidence.recordAssertionEvidence("preview", JSON.stringify(json).slice(0, 4000), !isError);
    expect(isError).toBe(false);
  });

  await step("then reading the plugins cost a handful of GitHub API calls, not one per file", async () => {
    const requests = await world.githubRequests();
    const api = requests.filter((request) => request.kind === "api");
    const raw = requests.filter((request) => request.kind === "raw");
    evidence.recordAssertionEvidence(
      "GitHub requests for one marketplace preview",
      `${api.length} API (${api.map((request) => request.path.replace(/^\/api\/repos\/[^/]+\/[^/]+/, "")).join(", ")}); ${raw.length} raw downloads; ${SKILL_FILES.length} skills in the repo`,
      api.length <= 3,
    );
    expect(api.length).toBeLessThanOrEqual(3);
  });

  await step("and the agent imports the productivity plugin's skills and connectors for the whole organization", async () => {
    // Skills are opt-in by key, as the MCP instructions tell agents to confirm.
    const preview = await callTool("execute_capability", {
      name: "postPluginsImportMcpsFromGithubUrlPreview",
      body: { githubUrl: world.repoUrl("productivity") },
    });
    const item = isRecord(preview.json) && isRecord(preview.json.item) ? preview.json.item : {};
    const skillKeys = records(item.skills).filter((skill) => skill.supported === true).map((skill) => String(skill.skillKey));
    const { isError, json } = await callTool("execute_capability", {
      name: "postPluginsImportMcpsFromGithubUrl",
      body: { githubUrl: world.repoUrl("productivity"), name: PLUGIN_NAME, access: { orgWide: true }, selectedSkillKeys: skillKeys },
    });
    const imported = isRecord(json) && isRecord(json.item) ? json.item : {};
    const connectors = records(imported.imported).map((entry) => String(entry.name));
    const skills = records(imported.importedSkills).map((entry) => String(entry.name ?? entry.title ?? entry.skillKey));
    evidence.recordAssertionEvidence(
      "imported",
      isError ? `import failed: ${JSON.stringify(json).slice(0, 600)}` : `connectors: ${connectors.join(", ")}; skills: ${skills.join(", ")}; skipped connectors in preview: ${records(item.servers).filter((server) => server.supported !== true).map((server) => `${String(server.name)} (${String(server.skippedReason)})`).join(", ")}`,
      !isError && skills.length === 2,
    );
    expect(isError).toBe(false);
    expect(connectors.sort()).toEqual(["notion", "slack"]);
    expect(skills).toHaveLength(2);
  });

  await step("after: the agent finds the migrated skill and is told what setup it still needs", async () => {
    const { json } = await callTool("list_skills", { query: "task" });
    const skills = records(isRecord(json) ? json.skills : []);
    // Imported skills get a unique suffix (task-management-xxxx); match plugin and prefix.
    const taskSkill = skills.find((skill) => String(skill.name).startsWith("task-management") && skill.pluginName === PLUGIN_NAME);
    evidence.recordAssertionEvidence("list_skills", skills.map((skill) => `${String(skill.name)} (${String(skill.pluginName ?? "")})`).join(", "), Boolean(taskSkill));
    expect(taskSkill).toBeDefined();
    // The plugin's Slack and Notion connections are not set up yet, so the
    // skill text is withheld; the agent must learn why and who can fix it.
    const read = await callTool("get_skill", { name: String(taskSkill?.capability ?? "") });
    const error = isRecord(read.json) ? read.json : {};
    const action = isRecord(error.action) ? error.action : {};
    evidence.recordAssertionEvidence(
      "what the agent is told",
      `${String(error.error)}: ${String(error.message)} → ${String(action.label)}`,
      error.error === "skill_needs_setup",
    );
    expect(read.isError).toBe(true);
    expect(error).toMatchObject({ error: "skill_needs_setup", status: "needs_admin_setup" });
    expect(String(error.message)).not.toContain("no longer available");
    expect(action).toMatchObject({ type: "setup_connection" });
  });
});
