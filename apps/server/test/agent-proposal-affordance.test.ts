import assert from "node:assert/strict";
import { test } from "node:test";

import { personalAgentProposalSchema } from "@openwork/types/den/personal-agents";
import { z } from "zod";

import { OpenWorkExtensionsPreview } from "../src/opencode-plugins/openwork-extensions-preview.js";
import { openworkReadTransport } from "../src/opencode-plugins/openwork-read-transport.js";

const contract = z.object({
  context: z.object({
    contributions: z.array(z.object({ featureId: z.string() })),
    availableAffordances: z.array(z.object({
      id: z.string(),
      arguments: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean() })),
    })),
  }),
});
const never = [{ app: "Slack", action: "post message" }, { app: "Gmail" }];
const args = {
  name: "Bug watcher",
  brief: "Summarize new reports without posting messages or using email.",
  never,
  routine: {
    name: "Check #bugs",
    instructions: "Summarize the new reports.",
    schedule: { kind: "weekly", timezone: "UTC", days: ["Monday", "wed"], hour: 9, minute: 0 },
  },
};

test("personal agent discovery and execution check the flag independently", async () => {
  const plugin = await OpenWorkExtensionsPreview();
  let enabled = true;
  let checks = 0;
  try {
    await openworkReadTransport.run({
      async get(path) {
        if (path === "/managed-policy/personal-agents") {
          checks++;
          return { enabled };
        }
        assert.equal(path, "/experimental/connect/skills");
        return { skills: [] };
      },
      async post() {
        return { context: { availableAffordances: [] }, ...(enabled ? { personalAgentsEnabled: true } : {}) };
      },
    }, async () => {
      const on = contract.parse(JSON.parse(await plugin.tool.openwork_context.execute())).context;
      assert.equal(on.contributions.some(({ featureId }) => featureId === "agents"), true);
      const proposal = on.availableAffordances.find(({ id }) => id === "agent.propose");
      assert.deepEqual(proposal?.arguments.find(({ name }) => name === "never"), { name: "never", type: "array", required: false });
      assert.deepEqual(proposal?.arguments.find(({ name }) => name === "connectorNames"), { name: "connectorNames", type: "array", required: false });

      enabled = false;
      const denied: unknown = JSON.parse(await plugin.tool.openwork_execute.execute({ id: "agent.propose", args: { ...args, connectorNames: ["Slack"] } }, {}));
      assert.deepEqual(denied, { ok: false, id: "agent.propose", code: "unavailable", error: "Agents are not turned on for this organization." });
      const off = contract.parse(JSON.parse(await plugin.tool.openwork_context.execute())).context;
      assert.equal(off.contributions.some(({ featureId }) => featureId === "agents"), false);
      assert.equal(off.availableAffordances.some(({ id }) => id === "agent.propose"), false);
      assert.deepEqual(off.availableAffordances.find(({ id }) => id === "automation.propose"), on.availableAffordances.find(({ id }) => id === "automation.propose"));
      assert.equal(checks, 1);
    });
  } finally {
    plugin.dispose();
  }
});

test("a proposal with never restrictions and weekday names parses", async () => {
  const plugin = await OpenWorkExtensionsPreview();
  const resultSchema = z.object({ ok: z.literal(true), result: z.object({ proposal: personalAgentProposalSchema }) });
  try {
    await openworkReadTransport.run({
      async get() { return { enabled: true }; },
      async post() { throw new Error("A proposal should not change app state"); },
    }, async () => {
      const connectorNames = ["Slack"];
      const output = await plugin.tool.openwork_execute.execute({ id: "agent.propose", args: { ...args, connectorNames } }, {});
      const { result: { proposal } } = resultSchema.parse(JSON.parse(output));
      assert.deepEqual(proposal.connectorNames, connectorNames);
      assert.deepEqual(proposal.never, never);
      assert.deepEqual(proposal.routine.schedule, { kind: "weekly", timezone: "UTC", daysOfWeek: [1, 3], hour: 9, minute: 0 });

      const omitted = await plugin.tool.openwork_execute.execute({ id: "agent.propose", args }, {});
      assert.deepEqual(resultSchema.parse(JSON.parse(omitted)).result.proposal.connectorNames, []);
    });
  } finally {
    plugin.dispose();
  }
});
