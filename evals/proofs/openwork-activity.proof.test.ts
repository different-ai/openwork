import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { EARLIER_CHAT, GROUP_LABEL, MIXED_PROMPT, MIXED_REPLY, SCRIPT_PROMPT, SCRIPT_REPLY, openworkActivityWorld } from "../worlds/openwork-activity.ts";
import { SKILL_NAME } from "../worlds/created-skill-result.ts";

const test = spec.world(openworkActivityWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 720_000,
});

/** Internals that must never show in the default view of the rail (C3, T2). */
const INTERNALS = /openwork_(?:context|query|execute)|execute_capability|search_capabilities|create_skill|session\.(?:search|group)|getOrg|postPluginsAccess|grp_|ses_|Used context|Queried OpenWork/;
const RAIL = "[data-capability-call], [data-tool-aggregate], [data-code-mode-call]";

test("a member reads everything their agent did with OpenWork and their files as one quiet rail, with failures, blocks and the created skill reported truthfully", async ({ world, user, probe, step, evidence }) => {
  const railText = async () => (await probe.dom(RAIL)).elements.map((element) => element.text).join(" | ");

  await step("while a Cloud lookup is still running, every step so far sits on one rail with its mark, and only that step shimmers", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", MIXED_PROMPT);
    await probe.eventually(() => probe.dom('button[aria-label="Run task"]:not(:disabled)'), {
      within: 30_000, label: "the conversation is ready to run the task", until: (value) => value.elements.length === 1,
    });
    await user.click("Run task");
    await user.see({ text: "Looking up people in your organization" }, { timeoutMs: 120_000 });
    await user.see({ text: "Searched your chats for “client introduction”" });
    await user.see({ text: `Created the “${GROUP_LABEL}” group` });
    const shimmering = (await probe.dom("[data-capability-call] .ow-text-shimmer, [data-code-mode-call] .ow-text-shimmer")).elements.map((element) => element.text);
    const marks = (await probe.dom('[data-connector-icon="openwork"]')).elements.length;
    const text = await railText();
    const ok = shimmering.length === 1 && shimmering[0] === "Looking up people in your organization" && marks >= 3 && !INTERNALS.test(text);
    evidence.recordAssertionEvidence("One rail: OpenWork marks, plain sentences, one shimmer", `shimmering: ${JSON.stringify(shimmering)}; OpenWork marks: ${marks}; rail: ${text.slice(0, 220)}`, ok);
    expect(shimmering).toEqual(["Looking up people in your organization"]);
    expect(text).not.toMatch(INTERNALS);
    await user.screenshot();
  });

  await step("the local command and file read both succeeded", async () => {
    await user.see({ text: MIXED_REPLY }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 60_000 });
    const local = (await probe.dom("[data-tool-aggregate]")).elements;
    const failed = (await probe.dom('[data-tool-aggregate] .text-destructive')).elements.length > 0;
    let reason = "";
    if (failed) {
      // Say why, from the rail itself, before failing.
      await user.click({ text: /Ran (?:1 )?command, read 1 file/ });
      reason = (await probe.dom('[data-tool-aggregate-detail="error"], [data-tool-aggregate] .text-destructive')).elements.map((element) => element.text).join(" | ");
    }
    evidence.recordAssertionEvidence("Local work ran without errors", `local rows: ${local.map((element) => element.text).join(" | ")}${reason ? `; errors: ${reason.slice(0, 300)}` : ""}`, !failed);
    expect(reason).toBe("");
  });

  await step("after: the finished turn folds to one quiet line", async () => {
    await user.see("Run task", { timeoutMs: 60_000 });
    await probe.eventually(() => probe.dom('button[data-testid="completed-work-rail"]'), {
      within: 30_000, label: "the finished run folds", until: (value) => value.elements.length === 1,
    });
    await user.notSee({ text: "Searched your chats for “client introduction”" }, { timeoutMs: 5_000 });
    const rail = (await probe.dom('button[data-testid="completed-work-rail"]')).elements.map((element) => element.text);
    evidence.recordAssertionEvidence("The run folds to its duration and step count", `rail: ${JSON.stringify(rail)}`, rail.length === 1 && /^Worked for /.test(rail[0] ?? ""));
    expect(rail).toHaveLength(1);
    await user.screenshot();
  });

  await step("opening it lists plain sentences with local work grouped; lookups that did no visible work are left out; raw details open on request", async () => {
    await user.click({ testId: "completed-work-rail" });
    await user.see({ text: "Searched your chats for “client introduction”" });
    await user.see({ text: "Looked up people in your organization" });
    await user.see({ text: /Ran (?:1 )?command, read 1 file/ });
    await user.notSee({ text: /Checked what OpenWork can do|Searched your connections/ }, { timeoutMs: 1_000 });
    const called = (await world.toolCalls()).map((call) => call.name);
    const text = await railText();
    evidence.recordAssertionEvidence("The catalog lookup ran but is not a step a person reads", `Cloud calls served: ${JSON.stringify(called)}; rail: ${text.slice(0, 220)}`, called.includes("search_capabilities") && !INTERNALS.test(text));
    expect(called).toContain("search_capabilities");
    expect(text).not.toMatch(INTERNALS);
    // Raw details sit behind a code icon that appears when the row is hovered (P3).
    await user.hover({ text: "Looked up people in your organization" });
    await user.click({ label: "Show technical details for Looked up people in your organization" });
    await user.see({ text: /getOrg/ });
    await user.screenshot();
  });

  await step("a script that saves a skill and is blocked, and a command OpenWork refuses: the turn stays open, the skill is the result, nothing claims success", async () => {
    await user.click({ label: "Hide technical details for Looked up people in your organization" });
    await user.type("composer", SCRIPT_PROMPT);
    await user.click("Run task");
    await user.see({ text: SCRIPT_REPLY }, { timeoutMs: 120_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "Couldn't remove the group" });
    await user.see({ text: /No group matched Archive/ });
    const cards = (await probe.dom("[data-created-skill]")).elements.map((element) => element.text);
    const folds = (await probe.dom('button[data-testid="completed-work-rail"]')).elements.length;
    const failedMeta = (await probe.dom("[data-code-mode-call] .text-destructive")).elements.map((element) => element.text);
    const ok = cards.length === 1 && cards[0]?.includes(SKILL_NAME) === true && cards[0]?.includes("Only you") === true && folds === 1 && failedMeta.length === 0;
    evidence.recordAssertionEvidence("Turn stays open; one private skill card; the blocked script is not marked failed", `cards: ${JSON.stringify(cards)}; folded turns: ${folds}; red marks on the script: ${JSON.stringify(failedMeta)}`, ok);
    expect(ok).toBe(true);
    // A block is not a failure: the script reads as blocked, in neutral ink, and opens on request.
    await user.click({ label: "Sharing is blocked by your organization. Show steps" });
    await user.see({ text: "Created the Update CRM skill" });
    const blocked = (await probe.dom('[data-skill-share="blocked"]')).elements.length;
    const blockedRed = (await probe.dom('[data-skill-share="blocked"] .text-destructive')).elements.length;
    expect(blocked).toBe(1);
    expect(blockedRed).toBe(0);
    expect(await railText()).not.toMatch(INTERNALS);
    await user.screenshot();
  });

  await step("after a reload, the conversation's history reads the same", async () => {
    await user.reload();
    await user.see({ text: SCRIPT_REPLY }, { timeoutMs: 60_000 });
    await user.see({ text: "Couldn't remove the group" });
    const folds = (await probe.dom('button[data-testid="completed-work-rail"]')).elements.length;
    const cards = (await probe.dom("[data-created-skill]")).elements.map((element) => element.text);
    const ok = folds === 1 && cards.length === 1 && cards[0]?.includes("Only you") === true;
    evidence.recordAssertionEvidence("History keeps the fold, the failure and the one card", `folded turns: ${folds}; cards: ${JSON.stringify(cards)}`, ok);
    expect(ok).toBe(true);
    expect(await railText()).not.toMatch(INTERNALS);
    await user.screenshot();
  });

  await step("the earlier chat the agent searched is untouched and the new group is in the sidebar", async () => {
    await user.see({ text: EARLIER_CHAT });
    const groups = (await probe.dom(`[data-sidebar-workspace-id="${world.workspace.workspaceId}"]`)).elements.map((element) => element.text).join(" | ");
    const ok = groups.includes(GROUP_LABEL) && groups.includes(EARLIER_CHAT);
    evidence.recordAssertionEvidence("The real sidebar shows the group the agent created and the chat it searched", `sidebar: ${groups.slice(0, 200)}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
