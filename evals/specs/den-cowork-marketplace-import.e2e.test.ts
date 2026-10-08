import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord, records } from "../worlds/library.ts";
import { COWORK_FIXTURE, denCoworkMarketplace } from "../worlds/den-cowork-marketplace.ts";

const test = spec.world(denCoworkMarketplace, { timeout: 900_000, resources: { surfaces: [], services: ["den"] } });

// A reused Daytona Den keeps earlier runs' plugins; each run imports under its own name.
const PLUGIN_NAME = `Productivity ${Date.now().toString(36)}`;
const SKILL_FILES = Object.keys(COWORK_FIXTURE.files).filter((path) => path.endsWith("/SKILL.md"));

test("an admin's agent migrates a Cowork plugin into the organization and can safely run the migration again", async ({ world, step, evidence }) => {
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

  let firstImportMode = "";

  await step("and the agent imports the productivity plugin without hand-picking its skills", async () => {
    const { isError, json } = await callTool("execute_capability", {
      name: "postPluginsImportMcpsFromGithubUrl",
      body: { githubUrl: world.repoUrl("productivity"), name: PLUGIN_NAME, access: { orgWide: true } },
    });
    const imported = isRecord(json) && isRecord(json.item) ? json.item : {};
    const connectors = records(imported.imported).map((entry) => String(entry.name)).sort();
    const skills = records(imported.importedSkills).map((entry) => String(entry.name)).sort();
    firstImportMode = String(imported.mode);
    evidence.recordAssertionEvidence(
      "imported",
      isError ? `import failed: ${JSON.stringify(json).slice(0, 600)}` : `mode ${firstImportMode}; connectors: ${connectors.join(", ")}; skills: ${skills.join(", ")}`,
      !isError && skills.length === 2,
    );
    expect(isError).toBe(false);
    expect(firstImportMode).toBe("created");
    expect(connectors).toEqual(["notion", "slack"]);
    expect(skills).toEqual(["start", "task-management"]);
  });

  await step("then the agent reads a migrated skill by its plain name, before any connector is set up", async () => {
    const read = await callTool("get_skill", { name: `${PLUGIN_NAME}/task-management` });
    const skill = isRecord(read.json) ? read.json : {};
    const content = typeof skill.content === "string" ? skill.content : "";
    evidence.recordAssertionEvidence(
      "get_skill productivity/task-management",
      read.isError ? `error: ${JSON.stringify(read.json).slice(0, 500)}` : `${String(skill.name)}: ${content.split("\n").filter(Boolean).slice(-1)[0] ?? ""}`,
      !read.isError && content.includes("Keep TASKS.md up to date."),
    );
    expect(read.isError).toBe(false);
    expect(content).toContain("Keep TASKS.md up to date.");
  });

  await step("and the skill's connectors are offered as optional, each saying how to connect it", async () => {
    const { json } = await callTool("list_skills", { query: "task" });
    const listed = records(isRecord(json) ? json.skills : []).find((skill) => skill.pluginName === PLUGIN_NAME);
    const run = await callTool("execute_capability", { name: String(listed?.capability ?? "") });
    const result = isRecord(run.json) ? run.json : {};
    const requirements = records(result.mcpRequirements);
    evidence.recordAssertionEvidence(
      "optional connectors",
      requirements.map((requirement) => `${String(requirement.serverName)}: ${String(requirement.state)} (optional ${String(requirement.optional)})`).join("; "),
      requirements.length === 2 && requirements.every((requirement) => requirement.optional === true),
    );
    expect(typeof result.content).toBe("string");
    expect(requirements.map((requirement) => String(requirement.serverName)).sort()).toEqual(["notion", "slack"]);
    expect(requirements.every((requirement) => requirement.optional === true)).toBe(true);
  });

  await step("when the agent runs the same migration again, nothing is duplicated", async () => {
    const { isError, json } = await callTool("execute_capability", {
      name: "postPluginsImportMcpsFromGithubUrl",
      body: { githubUrl: world.repoUrl("productivity"), name: PLUGIN_NAME, access: { orgWide: true } },
    });
    const item = isRecord(json) && isRecord(json.item) ? json.item : {};
    const unchanged = records(item.unchanged).map((entry) => `${String(entry.objectType)}:${String(entry.name)}`).sort();
    evidence.recordAssertionEvidence(
      "re-run",
      isError ? `failed: ${JSON.stringify(json).slice(0, 400)}` : `mode ${String(item.mode)}; unchanged: ${unchanged.join(", ")}; new: ${records(item.importedSkills).length + records(item.imported).length}`,
      !isError && item.mode === "updated",
    );
    expect(isError).toBe(false);
    expect(item.mode).toBe("updated");
    expect(unchanged).toEqual(["mcp:notion", "mcp:slack", "skill:start", "skill:task-management"]);
    expect(records(item.importedSkills)).toHaveLength(0);
  });

  await step("after: an upstream edit to a skill reaches the organization on the next run", async () => {
    const path = "productivity/skills/task-management/SKILL.md";
    const edited = String(COWORK_FIXTURE.files[path]).replace("Keep TASKS.md up to date.", "Keep TASKS.md up to date and archive done items weekly.");
    await world.setRepoFile(path, edited);
    const { json } = await callTool("execute_capability", {
      name: "postPluginsImportMcpsFromGithubUrl",
      body: { githubUrl: world.repoUrl("productivity"), name: PLUGIN_NAME, access: { orgWide: true } },
    });
    const item = isRecord(json) && isRecord(json.item) ? json.item : {};
    const updated = records(item.updatedSkills).map((entry) => String(entry.name));
    const read = await callTool("get_skill", { name: `${PLUGIN_NAME}/task-management` });
    const content = isRecord(read.json) && typeof read.json.content === "string" ? read.json.content : "";
    evidence.recordAssertionEvidence(
      "upstream edit",
      `updatedSkills: ${updated.join(", ")}; skill now says "${content.includes("archive done items weekly") ? "…archive done items weekly." : content.slice(-80)}"`,
      updated.includes("task-management") && content.includes("archive done items weekly"),
    );
    expect(updated).toEqual(["task-management"]);
    expect(content).toContain("archive done items weekly");
  });

  await step("after: a skill and a connector deleted upstream leave the organization on the next run, and the rest stays", async () => {
    await world.deleteRepoFile("productivity/skills/start/SKILL.md");
    const mcpPath = "productivity/.mcp.json";
    const mcp: unknown = JSON.parse(String(COWORK_FIXTURE.files[mcpPath]));
    const servers = isRecord(mcp) && isRecord(mcp.mcpServers) ? { ...mcp.mcpServers } : {};
    delete servers.slack;
    await world.setRepoFile(mcpPath, JSON.stringify({ mcpServers: servers }, null, 2));

    const { isError, json } = await callTool("execute_capability", {
      name: "postPluginsImportMcpsFromGithubUrl",
      body: { githubUrl: world.repoUrl("productivity"), name: PLUGIN_NAME, access: { orgWide: true } },
    });
    const item = isRecord(json) && isRecord(json.item) ? json.item : {};
    const removed = records(item.removed).map((entry) => `${String(entry.objectType)}:${String(entry.name)}`).sort();
    const unchanged = records(item.unchanged).map((entry) => `${String(entry.objectType)}:${String(entry.name)}`).sort();
    const listed = await callTool("list_skills", { query: PLUGIN_NAME });
    const remaining = records(isRecord(listed.json) ? listed.json.skills : [])
      .filter((skill) => skill.pluginName === PLUGIN_NAME)
      // Names shared with other plugins come back with a short suffix ("task-management-1a2b3c4d").
      .map((skill) => String(skill.name).split("/").at(-1)?.replace(/-[a-z0-9]{8}$/, ""))
      .sort();
    const ok = !isError
      && removed.join() === "mcp:slack,skill:start"
      && remaining.join() === "task-management";
    evidence.recordAssertionEvidence(
      "upstream deletion",
      isError
        ? `failed: ${JSON.stringify(json).slice(0, 400)}`
        : `removed: ${removed.join(", ") || "none"}; unchanged: ${unchanged.join(", ")}; plugin's skills now: ${remaining.join(", ")}`,
      ok,
    );
    expect(isError).toBe(false);
    expect(removed).toEqual(["mcp:slack", "skill:start"]);
    expect(unchanged).toEqual(["mcp:notion", "skill:task-management"]);
    expect(remaining).toEqual(["task-management"]);
  });
});
