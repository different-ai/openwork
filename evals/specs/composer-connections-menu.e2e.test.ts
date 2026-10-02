import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectionsMenu } from "../worlds/chat.ts";

const test = spec.world(connectionsMenu);

const plusButton = { role: "button", label: "Add files, skills, connectors, and more" } as const;
const menuSearch = { placeholder: "Search files, skills, connectors" } as const;

test("a member: I want to use a connector in this message", async ({ world, user, probe, step, evidence }) => {
  const slack = world.connections.find((connection) => connection.name === "Slack");
  if (!slack) throw new Error("The world has no Slack connection.");
  const menuOpen = async () => (await probe.dom("[data-composer-plus-menu]")).elements.length > 0;

  await step("1. before: the Connectors section lists each organization connector with its logo, and Slack asks me to sign in", async () => {
    await user.click(plusButton);
    await user.click({ role: "option", label: /^Connectors/ });
    await user.see({ placeholder: "Search connectors" });
    for (const connection of world.connections) await user.see({ role: "option", label: new RegExp(`^${connection.name}`) });
    await user.see({ role: "button", label: "Connect Slack" });
    await user.screenshot();
  });

  await step("2. Connect on the Slack row signs me in without leaving the menu", async () => {
    const connectStartedAt = new Date().toISOString();
    await user.click({ role: "button", label: "Connect Slack" });
    // TODO(primitive): read an OAuth authorization request from a mock connector.
    const authorization = await world.den.mocks.connector.authorizeRequestSince(connectStartedAt);
    expect(authorization.params.get("state")).toBeTruthy();
    const connected = await probe.eventually(async () => {
      const response = await probe.api(world.den.admin, "/v1/mcp-connections?scope=usable");
      const serialized = JSON.stringify(response.body);
      return serialized.includes(slack.id) && serialized.includes('"connectedForMe":true');
    }, { within: 90_000, intervalMs: 1_000, label: "Den reports Slack connected for me", until: (value) => value });
    expect(connected).toBe(true);
    if (!(await menuOpen())) {
      await user.click(plusButton);
      await user.click({ role: "option", label: /^Connectors/ });
    }
    await probe.eventually(async () => (await probe.dom('[aria-label="Connect Slack"]')).elements.length, {
      within: 90_000, intervalMs: 500, label: "the Slack row drops its Connect button", until: (count) => count === 0,
    });
    await user.notSee({ role: "button", label: "Connect Slack" });
    evidence.recordAssertionEvidence("Signing in from the row connects Slack for me", `OAuth state issued; Den connectedForMe=${connected}; the row no longer offers Connect`, connected);
    await user.screenshot();
  });

  await step("3. choosing Slack puts it in my message as a token", async () => {
    await user.click({ role: "option", label: /^Slack/ });
    await probe.eventually(menuOpen, { within: 5_000, intervalMs: 20, label: "the + menu closes", until: (open) => !open });
    await user.notSee(menuSearch);
    const tokens = await probe.dom("[data-composer-connector]");
    expect(tokens.elements.map((element) => element.text)).toEqual(["Slack"]);
    await user.screenshot();
  });

  await step("after: HubSpot still asks for its own sign-in; connecting Slack did not connect it", async () => {
    await user.click(plusButton);
    await user.type(menuSearch, "hbspt");
    await user.see({ role: "option", label: /^HubSpot/ });
    await user.see({ role: "button", label: "Connect HubSpot" });
    evidence.recordAssertionEvidence("Other connectors keep their own sign-in", "HubSpot still shows Connect after Slack was connected", true);
    await user.screenshot();
  });
});
