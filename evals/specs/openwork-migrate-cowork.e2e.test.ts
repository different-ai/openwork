import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord, records } from "../worlds/library.ts";
import { denCoworkMarketplace, OWN_COWORK_SKILL } from "../worlds/den-cowork-marketplace.ts";

const test = spec.world(denCoworkMarketplace, { timeout: 900_000, resources: { surfaces: [], services: ["den"] } });

// The command an agent runs from Claude Cowork or Claude Code when a person
// asks to move to OpenWork (openworklabs.com/migrate.md). The computer has
// Cowork's files: one GitHub marketplace, one marketplace in a local folder,
// a skill the person wrote, and one of Anthropic's built-in skills.
test("an admin's agent moves their Cowork plugins and own skills to OpenWork with one command, and can run it again", async ({ world, step, evidence }) => {
  await step("given the agent scans the computer, it finds the marketplace and the person's own skill", async () => {
    const run = await world.migrate(["scan"]);
    const found = isRecord(run.json) ? run.json : {};
    const marketplaces = records(found.marketplaces).map((entry) => String(entry.url));
    const skills = records(found.skills).map((entry) => String(entry.name));
    const unsupported = records(found.unsupported).map((entry) => `${String(entry.name)} (${String(entry.reason)})`);
    evidence.recordAssertionEvidence("scan", `marketplaces: ${marketplaces.join(", ")}; own skills: ${skills.join(", ")}; not importable: ${unsupported.join(", ")}`, run.code === 0);
    expect(run.code).toBe(0);
    expect(marketplaces).toEqual([world.repoUrl()]);
    expect(skills).toEqual([OWN_COWORK_SKILL.name]);
    expect(unsupported).toEqual(["team-folder (not_on_github)"]);
  });

  await step("when the agent previews the move, nothing changes and every plugin is listed", async () => {
    const run = await world.migrate(["plan"]);
    const plan = isRecord(run.json) ? run.json : {};
    const plugins = records(records(plan.marketplaces)[0]?.plugins);
    const productivity = plugins.find((plugin) => plugin.name === "productivity");
    evidence.recordAssertionEvidence(
      "plan",
      plugins.map((plugin) => `${String(plugin.name)}: ${records(plugin.needsSetup).length} to set up, ${(Array.isArray(plugin.skills) ? plugin.skills : []).length} skills`).join("; "),
      run.code === 0 && plugins.length === 3,
    );
    expect(run.code).toBe(0);
    expect(plugins.map((plugin) => String(plugin.name)).sort()).toEqual(["brand-voice", "productivity", "sales"]);
    expect(records(productivity?.needsSetup).map((entry) => String(entry.name)).sort()).toEqual(["gmail", "google calendar"]);
  });

  await step("then the agent imports the plugin the person uses, plus their own skill", async () => {
    const run = await world.migrate(["apply", "--plugin", "productivity"]);
    const result = isRecord(run.json) ? run.json : {};
    const plugin = records(result.plugins)[0] ?? {};
    const ownSkill = records(result.skills)[0] ?? {};
    const nextSteps = Array.isArray(result.nextSteps) ? result.nextSteps.map(String) : [];
    evidence.recordAssertionEvidence(
      "apply",
      plugin.ok === true
        ? `productivity ${String(plugin.mode)}: skills ${JSON.stringify(plugin.skillsAdded)}, connectors ${JSON.stringify(plugin.connectorsAdded)}; own skill ${String(ownSkill.mode)}; still to do: ${nextSteps.length}`
        : `productivity failed: ${String(plugin.error)}; stderr: ${run.stderr.slice(0, 300)}`,
      run.code === 0,
    );
    expect(run.code).toBe(0);
    expect(plugin).toMatchObject({ ok: true, mode: "created" });
    expect(plugin.skillsAdded).toEqual(expect.arrayContaining(["start", "task-management"]));
    expect(ownSkill).toMatchObject({ skill: OWN_COWORK_SKILL.name, ok: true, mode: "created" });
    expect(nextSteps.some((line) => line.includes("gmail"))).toBe(true);
  });

  await step("and the organization's agent can read both, by the names the person knows", async () => {
    const plugin = await world.callTool("get_skill", { name: "productivity/task-management" });
    const own = await world.callTool("get_skill", { name: OWN_COWORK_SKILL.name });
    const pluginText = isRecord(plugin.json) && typeof plugin.json.content === "string" ? plugin.json.content : "";
    const ownText = isRecord(own.json) && typeof own.json.content === "string" ? own.json.content : "";
    evidence.recordAssertionEvidence(
      "get_skill",
      `productivity/task-management: ${pluginText.includes("Keep TASKS.md up to date.") ? "readable" : "missing"}; ${OWN_COWORK_SKILL.name}: ${ownText.includes("five bullets") ? "readable" : "missing"}`,
      pluginText.includes("Keep TASKS.md up to date.") && ownText.includes("five bullets"),
    );
    expect(pluginText).toContain("Keep TASKS.md up to date.");
    expect(ownText).toContain("five bullets");
  });

  await step("after: running the same command again changes nothing", async () => {
    const run = await world.migrate(["apply", "--plugin", "productivity"]);
    const result = isRecord(run.json) ? run.json : {};
    const plugin = records(result.plugins)[0] ?? {};
    const ownSkill = records(result.skills)[0] ?? {};
    evidence.recordAssertionEvidence(
      "re-run",
      `productivity ${String(plugin.mode)}, ${String(plugin.unchanged)} unchanged, ${JSON.stringify(plugin.skillsAdded)} added; own skill ${String(ownSkill.mode)}`,
      run.code === 0 && plugin.mode === "updated" && ownSkill.mode === "unchanged",
    );
    expect(run.code).toBe(0);
    expect(plugin).toMatchObject({ mode: "updated", skillsAdded: [], skillsUpdated: [] });
    expect(ownSkill).toMatchObject({ mode: "unchanged" });
  });
});
