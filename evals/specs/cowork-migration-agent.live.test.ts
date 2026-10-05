import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord, records } from "../worlds/library.ts";
import { AGENT_KEY_ENV, coworkAgentMigration } from "../worlds/cowork-agent-migration.ts";
import type { AgentRun } from "../worlds/cowork-agent-migration.ts";
import { OWN_COWORK_SKILL } from "../worlds/den-cowork-marketplace.ts";

// A real Claude Code agent (real model, headless) follows migrate.md on a
// computer that has Claude Cowork's files. Live: it needs a model key and is
// never part of PR or E2E suites. Run it by exact name:
//   OPENWORK_EVAL_AGENT_ANTHROPIC_API_KEY=… pnpm evals:pr specs/cowork-migration-agent.live.test.ts
const test = spec.world(coworkAgentMigration, {
  timeout: 1_800_000,
  resources: { surfaces: [], services: ["den"] },
  needs: { env: [AGENT_KEY_ENV], commands: ["claude"] },
});

// What a person would actually type. No commands, flags, or file paths
// beyond the guide itself; the answers an interactive agent would ask for
// (which plugins, whether to upload their own skills) are given up front
// because a headless run cannot ask.
const MESSAGE = [
  "Follow ./migrate.md to move my Claude plugins and skills to OpenWork.",
  "I only use the productivity plugin. It's fine to upload the skills I wrote myself.",
].join(" ");

test("a person's own coding agent follows migrate.md and moves their Cowork setup to OpenWork", { timeout: 1_800_000 }, async ({ world, step, evidence }) => {
  let run: AgentRun = { code: 1, commands: [], finalText: "", transcript: "", turns: 0 };

  await step("given the person pastes the migration prompt into Claude Code", async () => {
    run = await world.runAgent(MESSAGE);
    evidence.recordAssertionEvidence(
      "the agent ran",
      `exit ${run.code}, ${run.turns} turns; commands:\n${run.commands.map((command) => `$ ${command}`).join("\n")}`,
      run.code === 0,
    );
    expect(run.code).toBe(0);
  });

  await step("and signing in reused the account the person already has, without a new sign-in", async () => {
    const reused = run.transcript.includes("Already signed in");
    evidence.recordAssertionEvidence("sign-in", reused ? "openwork-bootstrap login answered \"Already signed in\"" : "login did not reuse the saved account", reused);
    expect(reused).toBe(true);
  });

  await step("then it looked before it changed anything, and moved only what the person uses", async () => {
    const ran = (word: string) => run.commands.findIndex((command) => command.includes(`migrate ${word}`));
    const scan = ran("scan");
    const plan = ran("plan");
    const apply = ran("apply");
    const applyCommands = run.commands.filter((command) => command.includes("migrate apply"));
    const ok = plan >= 0 && apply > plan && applyCommands.every((command) => command.includes("productivity") && !command.includes("--all"));
    evidence.recordAssertionEvidence(
      "scan → plan → apply, productivity only",
      `scan #${scan}, plan #${plan}, apply #${apply}; apply commands: ${applyCommands.join(" | ") || "none"}`,
      ok,
    );
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(apply).toBeGreaterThan(plan);
    for (const command of applyCommands) {
      expect(command).toContain("productivity");
      expect(command).not.toContain("--all");
    }
  });

  await step("and the organization now has the plugin's skills and the person's own skill", async () => {
    const { json } = await world.callTool("list_skills", {});
    const skills = records(isRecord(json) ? json.skills : []);
    const names = skills.map((skill) => `${String(skill.title)} (${String(skill.pluginName ?? "")})`);
    const hasTasks = skills.some((skill) => skill.title === "task-management" && String(skill.pluginName ?? "").startsWith("productivity"));
    const hasOwn = skills.some((skill) => skill.title === OWN_COWORK_SKILL.name);
    const hasSales = skills.some((skill) => String(skill.pluginName ?? "").startsWith("sales"));
    evidence.recordAssertionEvidence(
      "skills in OpenWork",
      names.filter((name) => !name.includes("(OpenWork")).join(", "),
      hasTasks && hasOwn && !hasSales,
    );
    expect(hasTasks).toBe(true);
    expect(hasOwn).toBe(true);
    expect(hasSales).toBe(false);
  });

  await step("after: it told the person what is left, and never printed their sign-in token", async () => {
    const mentionsNextStep = /gmail|google/i.test(run.finalText);
    const leaked = run.transcript.includes(world.sessionToken);
    evidence.recordAssertionEvidence(
      "final message",
      `${run.finalText.slice(0, 1200)}\n— names the Gmail/Google next step: ${mentionsNextStep}; token in transcript: ${leaked}`,
      mentionsNextStep && !leaked,
    );
    expect(mentionsNextStep).toBe(true);
    expect(leaked).toBe(false);
  });
});
