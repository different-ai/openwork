import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { openworkBenchTaskWorld } from "../worlds/openwork-bench-task.ts";

const test = spec.world(openworkBenchTaskWorld, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const ANSWER_MS = 180_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

test("an OpenWork Bench task runs in the app against its task world, and the task's own checks pass on what the agent did", async ({ world, user, agent, probe, step, evidence }) => {
  const v2 = world.engine === "v2";
  const session = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${v2 ? "opencode2/api" : "opencode"}/session/${world.session.sessionId}`;
  const assistantText = async () => {
    const response = await probe.desktopApi(v2 ? `${session}/context` : `${session}/message?limit=100`);
    expect(response.status).toBe(200);
    const messages = v2 ? record(response.body).data : response.body;
    return (Array.isArray(messages) ? messages : []).map(record)
      .filter((message) => (v2 ? message.type : record(message.info).role) === "assistant")
      .flatMap((message) => {
        const parts = v2 ? message.content : message.parts;
        return Array.isArray(parts) ? parts.map(record) : [];
      })
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
  };
  const summarize = (checks: { id: string; passed: boolean }[]) => checks.map((check) => `${check.passed ? "pass" : "fail"} ${check.id}`).join("; ");

  await step("before: the task world is attached and its checks fail, because nobody has answered Jordan yet", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const grade = await world.grade();
    evidence.recordAssertionEvidence(
      `Before the run, ${world.task} scores ${grade.score} (openwork-bench ${world.revision.slice(0, 7)})`,
      summarize(grade.checks),
      !grade.success && grade.score === 0,
    );
    expect(grade.success).toBe(false);
    expect(grade.score).toBe(0);
    await user.screenshot();
  });

  await step("after: the brief goes in through the composer, the agent works through the task world's mail and drive tools, and every check passes", async () => {
    await agent.send(world.brief);
    const answer = await probe.eventually(assistantText, {
      within: ANSWER_MS, label: "the agent's answer in the session", until: (text) => text.includes(world.reply),
    });
    await user.see({ text: world.reply }, { timeoutMs: 60_000 });
    const grade = await world.grade();
    evidence.recordAssertionEvidence(
      `After the run, ${world.task} scores ${grade.score} on the task world's final state`,
      summarize(grade.checks),
      grade.success && grade.checks.length > 0 && grade.checks.every((check) => check.passed),
    );
    expect(answer).toContain(world.reply);
    expect(grade).toMatchObject({ success: true, score: 1 });
    expect(grade.checks.length).toBeGreaterThan(0);
    expect(grade.checks.filter((check) => !check.passed)).toEqual([]);
    await user.screenshot();
  });
});
