import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appConnectionCard, appTitle, connectionName, dailyActiveUsers, dauToolName, openPrompt, openReply } from "../worlds/app-connection-card.ts";

const test = spec.world(appConnectionCard, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000,
});

test("an owner whose App's PostHog connection breaks sees how to fix the connection, not a raw error", async ({ world, agent, user, step, evidence }) => {
  let frame: Awaited<ReturnType<typeof world.appFrame>> | undefined;
  await using _openFrame = { [Symbol.asyncDispose]: async () => { await frame?.[Symbol.asyncDispose](); } };
  let openedAt = "";

  await step("before: the owner opens the PostHog DAU App in chat and it loads daily active users", async () => {
    openedAt = new Date().toISOString();
    await agent.send(openPrompt);
    await user.see({ text: openReply }, { timeoutMs: 120_000 });
    frame = await world.appFrame();
    const dau = user.on(frame);
    await dau.see({ role: "heading", label: appTitle });
    await dau.click({ role: "button", label: "Load DAU" });
    await dau.see({ testId: "dau" }, { text: dailyActiveUsers.toLocaleString("en-US"), timeoutMs: 90_000 });
    expect(await world.dauCalls({ sinceIso: openedAt, atLeast: 1 })).toHaveLength(1);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "The App loads its number through the PostHog connection",
      `One click on Load DAU ran the App's saved Workflow, which called PostHog's ${dauToolName} once; the App shows ${dailyActiveUsers.toLocaleString("en-US")}.`,
      true,
    );
  });

  await step("PostHog stops offering the DAU query the App's Workflow was saved with", async () => {
    await world.dropDauTool();
    evidence.recordAssertionEvidence(
      "The connection no longer serves the Workflow's tool",
      `The ${connectionName} MCP server now lists only query_wau, so ${dauToolName} is missing when the Workflow next runs.`,
      true,
    );
  });

  await step("after: the same click shows OpenWork's PostHog connection card in place of the App", async () => {
    if (!frame) throw new Error(`${appTitle} is not open`);
    const retriedAt = new Date().toISOString();
    await user.on(frame).click({ role: "button", label: "Load DAU" });
    await user.see({ testId: "desktop-connection-card" }, { timeoutMs: 90_000 });
    await user.see({ text: `Your organization admin must configure ${connectionName}` });
    await user.see({ role: "button", label: "Dismiss" });
    // The App's own error text, with OpenWork's raw JSON, is gone.
    await user.notSee({ text: /capability_unavailable/ });
    await user.notSee({ text: /unavailable or disabled for this organization/ });
    expect(await world.dauCalls({ sinceIso: retriedAt })).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "A missing connection tool reads as a connection problem with a next step",
      `Clicking Load DAU again ran the Workflow, which stopped before calling PostHog. In place of "Couldn't load DAU: {"error":"capability_unavailable",…}", the conversation shows OpenWork's ${connectionName} connection card: "Your organization admin must configure ${connectionName}". The App's own frame and its raw error are gone.`,
      true,
    );
  });
});
