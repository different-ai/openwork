import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { coworkPluginImport } from "../worlds/cowork-plugin-import.ts";

const test = spec.world(coworkPluginImport, { needs: { commands: ["bun"] }, timeout: 300_000 });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AGENT = "brand-voice-plugin/content-generation";

// Claude Code and Cowork plugin agents are helpers that skills delegate to.
// OpenWork wrote them without a mode, so the engine offered each one in the
// main agent picker next to the person's own agents.
test("a person who imports a Cowork plugin with helper agents keeps their agent picker unchanged", async ({ world, step, evidence }) => {
  let primaryBefore: string[] = [];

  await step("given a workspace with only the built-in agents", async () => {
    const agents = await world.engine("GET", "/agent");
    primaryBefore = Array.isArray(agents)
      ? agents.filter(record).filter((agent) => agent.mode !== "subagent" && agent.hidden !== true).map((agent) => String(agent.name)).sort()
      : [];
    evidence.recordAssertionEvidence("agents offered to the person", primaryBefore.join(", "), primaryBefore.length > 0);
    expect(primaryBefore.length).toBeGreaterThan(0);
  });

  await step("when the person imports brand-voice, which brings a content-generation helper", async () => {
    const result = await world.api("POST", "/claude-plugins", { url: world.repoUrl("partner-built/brand-voice") });
    expect(result.status).toBe(200);
    // New agent files are picked up when the engine reloads, as after the
    // app's reload prompt.
    await world.engine("POST", "/instance/dispose");
    const files = await world.installedFiles("agents");
    evidence.recordAssertionEvidence("agent installed", files.join(", "), files.includes("brand-voice-plugin/content-generation.md"));
    expect(files).toContain("brand-voice-plugin/content-generation.md");
  });

  await step("then the helper is available for delegation", async () => {
    const agents = await world.engine("GET", "/agent");
    const helper = Array.isArray(agents) ? agents.filter(record).find((agent) => agent.name === AGENT) : undefined;
    evidence.recordAssertionEvidence("helper agent", helper ? `${AGENT} mode=${String(helper.mode)}` : `${AGENT} missing`, helper?.mode === "subagent");
    expect(helper?.mode).toBe("subagent");
  });

  await step("after: the agents offered to the person are the same as before", async () => {
    const agents = await world.engine("GET", "/agent");
    const primaryAfter = Array.isArray(agents)
      ? agents.filter(record).filter((agent) => agent.mode !== "subagent" && agent.hidden !== true).map((agent) => String(agent.name)).sort()
      : [];
    evidence.recordAssertionEvidence("agents offered to the person", primaryAfter.join(", "), JSON.stringify(primaryAfter) === JSON.stringify(primaryBefore));
    expect(primaryAfter).toEqual(primaryBefore);
  });
});
