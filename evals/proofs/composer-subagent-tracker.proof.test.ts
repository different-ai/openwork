import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { composerSubagentTrackerWorld } from "../worlds/composer-subagent-tracker.ts";

const test = spec.world(composerSubagentTrackerWorld, {
  timeout: 480_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const TRACKER = "[data-subagent-tracker]";
const ROWS = "[data-subagent-tracker-row]";

test("a member running several sub-agents on OpenCode v2 keeps track of them from the composer", async ({ world, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  // The scenarios are dev-only control actions; the app renders them through its real list and store.
  const seedAgents = (scenario: string, extra: Record<string, unknown> = {}) => agent.run("eval.subagent_tracker.seed", { scenario, ...extra });
  const tracker = async () => (await probe.dom(TRACKER)).elements;
  const rowText = async () => (await probe.dom(`${ROWS} [data-subagent-tracker-status]`)).elements.map((element) => element.text);
  const summary = async () => (await probe.dom("[data-subagent-tracker-summary]")).elements[0]?.text ?? "";

  await step("before: with the Agents list off, a turn's sub-agents only show as rows in the chat", async () => {
    await agent.run("session.open", { sessionId });
    await seedAgents("mixed");
    await user.see({ text: "Map the billing service" }, { timeoutMs: 30_000 });
    const found = (await tracker()).length;
    evidence.recordAssertionEvidence("Nothing is attached to the composer while the switch is off", `Agents lists on screen: ${found}`, found === 0);
    expect(found).toBe(0);
    await user.screenshot();
  });

  await step("after: one running sub-agent sits on top of the composer with its name, task and time", async () => {
    await world.setTracker(true);
    await user.reload();
    await agent.run("session.open", { sessionId });
    await seedAgents("one");
    const rows = await probe.eventually(rowText, { within: 30_000, intervalMs: 200, label: "the Agents list", until: (found) => found.length === 1 });
    evidence.recordAssertionEvidence("The running agent reads Working with a live time", `status: ${rows.join(", ")}`, /^Working \d+s$/.test(rows[0] ?? ""));
    expect(rows[0]).toMatch(/^Working \d+s$/);
    await user.see({ text: "Explore" });
    await user.screenshot();
  });

  await step("four quiet agents start folded to one line of counts", async () => {
    await seedAgents("mixed");
    const line = await probe.eventually(summary, { within: 15_000, intervalMs: 200, label: "the counts", until: (text) => text.includes("done") });
    const folded = (await probe.dom(`${TRACKER}[data-subagent-tracker-expanded="false"]`)).elements.length === 1;
    evidence.recordAssertionEvidence("Folded, with working, error and done counted", `"${line}", folded: ${folded}`, folded && line === "1 working, 1 with an error, 2 done");
    expect(line).toBe("1 working, 1 with an error, 2 done");
    expect(folded).toBe(true);
    await user.screenshot();
  });

  await step("opening the list shows Done, Error and Stopped as plain words, one per agent", async () => {
    await user.click({ testId: "subagent-tracker-toggle" });
    await user.see({ text: "Stopped" });
    const words = await rowText();
    const expected = ["Done", "Error", "Stopped"];
    const ok = /^Working \d+s$/.test(words[0] ?? "") && expected.every((word, index) => words[index + 1] === word);
    evidence.recordAssertionEvidence("Each agent's state is one word", words.join(" | "), ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("a sub-agent with a question says Waiting for your answer and offers Review", async () => {
    await seedAgents("question");
    await user.see({ text: "Plan the data migration" });
    const attention = (await probe.dom(`${ROWS}[data-subagent-tracker-kind="attention"]`)).elements.map((element) => element.text);
    const ok = attention.length === 1 && attention[0]!.includes("Waiting for your answer") && attention[0]!.includes("Review");
    evidence.recordAssertionEvidence("The waiting agent is the one row marked for attention", attention.join(" | "), ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("when every agent has finished but the turn still runs, the list folds to 3 done", async () => {
    await seedAgents("done");
    const line = await probe.eventually(summary, { within: 15_000, intervalMs: 200, label: "the counts", until: (text) => text === "3 done" });
    const folded = (await probe.dom(`${TRACKER}[data-subagent-tracker-expanded="false"]`)).elements.length === 1;
    evidence.recordAssertionEvidence("All done reads as one folded line", `"${line}", folded: ${folded}`, line === "3 done" && folded);
    expect(folded).toBe(true);
    await user.screenshot();
  });

  await step("once the turn ends with every agent settled, the list goes away", async () => {
    await seedAgents("done", { parentIdle: true });
    const left = (await probe.eventually(tracker, { within: 15_000, intervalMs: 200, label: "the list leaves", until: (found) => found.length === 0 })).length;
    evidence.recordAssertionEvidence("No Agents list after a finished turn", `Agents lists on screen: ${left}`, left === 0);
    expect(left).toBe(0);
    await user.screenshot();
  });

  await step("in a narrow window each agent keeps its name and state and the task text steps aside", async () => {
    await user.resizeViewport({ width: 460, height: 860, deviceScaleFactor: 1 });
    await seedAgents("mixed");
    await user.click({ testId: "subagent-tracker-toggle" });
    await user.see({ text: "Stopped" });
    const tasks = (await probe.dom("[data-subagent-tracker-task]")).elements;
    const rows = (await probe.dom(ROWS)).elements;
    const hidden = tasks.every((element) => element.rect.width === 0);
    const fits = rows.every((row) => row.rect.right <= 460);
    evidence.recordAssertionEvidence("Rows fit the window and task text is hidden", `task widths: ${tasks.map((element) => element.rect.width).join(", ")}; row right edges: ${rows.map((row) => Math.round(row.rect.right)).join(", ")}`, hidden && fits);
    expect(hidden && fits).toBe(true);
    await user.screenshot();
    await user.resizeViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
  });

  await step("a sub-agent asking for approval says Needs permission, and Review moves focus to the approval card", async () => {
    const child = await agent.run("eval.child_permission.seed");
    const childSessionId = child && typeof child === "object" && "childSessionId" in child && typeof child.childSessionId === "string" ? child.childSessionId : "";
    expect(childSessionId).not.toBe("");
    await seedAgents("permission", { permissionChildSessionId: childSessionId });
    await user.see({ text: "Needs permission" });
    await user.click({ testId: "subagent-tracker-review" });
    const focused = await probe.eventually(async () => (await probe.dom("[data-composer-interaction] button")).elements.some((element) => element.focused), {
      within: 5_000, intervalMs: 100, label: "focus on the approval card", until: (value) => value,
    });
    evidence.recordAssertionEvidence("Review lands on the approval card's buttons", `focused inside the approval card: ${focused}`, focused);
    expect(focused).toBe(true);
    await user.screenshot();
  });
});
