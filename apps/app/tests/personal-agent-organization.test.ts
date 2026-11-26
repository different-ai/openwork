import { expect, test } from "bun:test";
import type { PersonalAgentTool } from "@openwork/types/den/personal-agents";

import { DenApiError } from "../src/app/lib/den";
import { agentChangeDetails, isStaleChange } from "../src/react-app/domains/agents/agent-change-request";
import { toolControlState } from "../src/react-app/domains/agents/agent-permission-words";
import { agentSidebarGroups } from "../src/react-app/domains/agents/agent-sidebar-section";
import { agentRunQueueMessage, agentRunSource } from "../src/react-app/domains/agents/use-agents";

test("Run now shows a queue-specific message only for the queue conflict", () => {
  expect(agentRunQueueMessage(new DenApiError(409, "personal_agent_run_queue_full", "Conflict")))
    .toBe("This agent already has several runs waiting. Try again when one finishes.");
  expect(agentRunQueueMessage(new DenApiError(409, "personal_agent_routine_required", "Conflict"))).toBeNull();
  expect(agentRunQueueMessage(new DenApiError(500, "personal_agent_run_queue_full", "Failed"))).toBeNull();
  expect(agentRunQueueMessage(null)).toBeNull();
});

test("a stale approval is recognized only for the matching Den conflict", () => {
  expect(isStaleChange(new DenApiError(409, "personal_agent_change_stale", "Conflict"))).toBe(true);
  expect(isStaleChange(new DenApiError(409, "personal_agent_request_decided", "Conflict"))).toBe(false);
  expect(isStaleChange(new DenApiError(500, "personal_agent_change_stale", "Error"))).toBe(false);
  expect(isStaleChange(null)).toBe(false);
});

const active = { state: "active" } as const;
const archived = { state: "archived" } as const;

test("the sidebar lists opened and auto-added agents and offers the other active shared agents", () => {
  const legacy = { name: "Daily summary", agent: active };
  const opened = { name: "Calendar brief", listed: true, agent: active };
  const offered = { name: "Bug watcher", listed: false, agent: active };
  const old = { name: "Old summary", listed: false, agent: archived };
  expect(agentSidebarGroups([legacy, offered, opened, old])).toEqual({ listed: [legacy, opened], offered: [offered] });
  expect(agentSidebarGroups([{ ...offered, listed: true }]).offered).toEqual([]);
});

test("one request shows every proposed routine field and the full new brief", () => {
  const schedule = { kind: "daily", timezone: "UTC", hour: 9, minute: 30 } as const;
  const instructions = `${"Read unread messages.\n".repeat(500)}Include the last message.`;
  const brief = `${"Watch the inbox.\n".repeat(300)}Keep the complete list.`;
  const { rows, tools } = agentChangeDetails({
    newRoutine: { name: "Read updates", instructions, schedule },
    routineId: "digest", name: "Weekly digest", active: false, schedule, instructions: "Group messages by sender", brief,
    toolPolicy: { connections: { slack: "block" }, tools: {} },
  }, { routines: [{ id: "digest", name: "Daily digest", state: "active", schedule, nextDueAt: null, latestRun: null }] });
  expect(rows.map(({ block, text }) => [block, text])).toEqual([
    [undefined, "Add a routine: Read updates, Every day at 9:30 AM (UTC)"],
    ["instructions", instructions],
    [undefined, "Edit routine: Daily digest"],
    [undefined, "Rename it to Weekly digest"],
    [undefined, "Turn it off"],
    [undefined, "Schedule: Every day at 9:30 AM (UTC)"],
    ["instructions", "Group messages by sender"],
    ["brief", brief],
  ]);
  expect(tools?.map(({ text }) => text)).toEqual(["Unknown app: Block"]);
  expect(agentChangeDetails({ active: true }).rows.map(({ text }) => text)).toEqual(["Edit an existing routine", "Turn it on"]);
  expect(agentChangeDetails(null)).toEqual({ rows: [], tools: null });
});

test("a calendar change shows its timing, zone and filters", () => {
  const { rows } = agentChangeDetails({ schedule: {
    kind: "calendar", timezone: "America/Los_Angeles", edge: "end", offsetMinutes: 15,
    rule: { withExternalAttendees: true, titleIncludes: "Planning" },
  } });
  expect(rows[1]?.text).toBe("Schedule: 15 min after the end of each meeting (America/Los_Angeles). Only meetings with external guests. Only meetings with ‘Planning’ in the title");
});

test("tool changes name the app and tool, skip unchanged settings, and show removals", () => {
  const toolPolicy = { connections: { slack: "block" }, tools: { slack: { post: "ask", read: "allow" } } } as const;
  const change = { toolPolicy: { connections: {}, tools: { slack: { post: "allow", read: "allow", delete: "block" } } } } as const;
  const catalog = { connections: [{
    connectionId: "slack", name: "Slack", available: true, blocked: false, lockedByOrganization: false, sharedLogin: null, canShareLogin: false,
    tools: [{ name: "post", title: "Post a message", write: true, access: "ask", chosen: "ask", lockedByOrganization: false, organizationRule: null }],
  }] } satisfies NonNullable<Parameters<typeof agentChangeDetails>[1]>["catalog"];
  expect(agentChangeDetails(change, { toolPolicy, catalog }).tools?.map(({ text }) => text)).toEqual([
    "Slack · Post a message: Allow", "Slack · delete: Block", "Slack: Use the default",
  ]);
  expect(agentChangeDetails(change, { catalog }).tools?.map(({ text }) => text)).toEqual([
    "Slack · Post a message: Allow", "Slack · read: Allow", "Slack · delete: Block",
  ]);
  expect(agentChangeDetails(change, { toolPolicy: change.toolPolicy }).tools).toEqual([]);
});

const tool: Pick<PersonalAgentTool, "access" | "chosen" | "lockedByOrganization" | "organizationRule"> = {
  access: "allow", chosen: "allow", lockedByOrganization: false, organizationRule: "ask",
};

test("an admin ask rule disables Allow and does not override a block", () => {
  expect(toolControlState(tool)).toEqual({ access: "ask", allowDisabled: true, hint: "Your admin requires this to ask first." });
  expect(toolControlState({ ...tool, access: "block", chosen: "block" }).access).toBe("block");
  expect(toolControlState({ ...tool, access: "block", lockedByOrganization: true })).toEqual({ access: "block", allowDisabled: true, hint: null });
});

test("an admin allow rule is the default, not an override", () => {
  expect(toolControlState({ ...tool, access: "ask", organizationRule: "allow", chosen: null }))
    .toEqual({ access: "allow", allowDisabled: false, hint: "Allowed by your admin." });
  expect(toolControlState({ ...tool, access: "ask", organizationRule: "allow", chosen: "ask" }))
    .toEqual({ access: "ask", allowDisabled: false, hint: null });
  expect(toolControlState({ ...tool, access: "block", organizationRule: "allow", chosen: null }, true).access).toBe("block");
});

test("shared scheduled and recovery runs use summaries, not receipts", () => {
  for (const role of ["manager", "collaborator"] as const) {
    expect(agentRunSource(role, { trigger: "scheduled" })).toBe("summary");
    expect(agentRunSource(role, { trigger: "recovery" })).toBe("summary");
    expect(agentRunSource(role, { trigger: "manual" })).toBe("receipt");
  }
  expect(agentRunSource("owner", { trigger: "scheduled" })).toBe("receipt");
});
