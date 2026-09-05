import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectionsMenu } from "../worlds/chat.ts";

const test = spec.world(connectionsMenu);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("the composer connections menu scrolls through Den inventory and signs in on the row", async ({ world, user, seed, probe, step }) => {
  const target = world.connections.at(-1);
  if (!target) throw new Error("The connection inventory was empty.");

  await user.click({ role: "button", label: "Connections (MCPs)" });
  for (const connection of world.connections) await user.see({ text: connection.name });

  await step("the connection inventory has an independently scrolling list", async () => {
    // TODO(primitive): inspect overflow geometry for a visible connection list.
    const before = await probe.eval(`(targetName) => {
      const title = [...document.querySelectorAll("div")]
        .find((entry) => (entry.textContent ?? "").trim() === targetName && entry.children.length === 0);
      const row = title?.parentElement?.parentElement?.parentElement;
      const list = row?.parentElement?.parentElement;
      const navigation = [...document.querySelectorAll("button")]
        .find((entry) => (entry.textContent ?? "").trim() === "Connections (MCPs)")?.parentElement;
      const panel = navigation?.parentElement?.parentElement;
      if (!(row instanceof HTMLElement) || !(list instanceof HTMLElement) || !(navigation instanceof HTMLElement) || !(panel instanceof HTMLElement)) return null;
      list.scrollTop = 0;
      return {
        panelHeight: panel.clientHeight,
        navigationOverflow: getComputedStyle(navigation).overflowY,
        listOverflow: getComputedStyle(list).overflowY,
        listClientHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        targetInitiallyBelow: row.getBoundingClientRect().bottom > list.getBoundingClientRect().bottom,
      };
    }`, { args: [target.name] });
    expect(before).toMatchObject({ navigationOverflow: "auto", listOverflow: "auto", targetInitiallyBelow: true });
    if (!isRecord(before)
      || typeof before.panelHeight !== "number"
      || typeof before.listClientHeight !== "number"
      || typeof before.listScrollHeight !== "number") throw new Error("Connection-list geometry was unavailable.");
    expect(before.panelHeight).toBeGreaterThan(180);
    expect(before.listScrollHeight).toBeGreaterThan(before.listClientHeight);

    // TODO(primitive): scroll a named connection row into view.
    const scrolled = await seed.evalIn(world.app, `(targetName) => {
      const title = [...document.querySelectorAll("div")]
        .find((entry) => (entry.textContent ?? "").trim() === targetName && entry.children.length === 0);
      const row = title?.parentElement?.parentElement?.parentElement;
      const list = row?.parentElement?.parentElement;
      if (!(row instanceof HTMLElement) || !(list instanceof HTMLElement)) return false;
      list.scrollTop = list.scrollHeight;
      return list.scrollTop > 0;
    }`, { args: [target.name] });
    expect(scrolled).toBe(true);
    await user.see({ text: target.name });
    await user.see({ role: "button", label: "Connect your account", nth: 13 });
  });

  const connectStartedAt = new Date().toISOString();
  await user.click({ role: "button", label: "Connect your account", nth: 13 });
  // TODO(primitive): read an OAuth authorization request from a mock connector.
  const authorization = await world.den.mocks.connector.authorizeRequestSince(connectStartedAt);
  expect(authorization.params.get("state")).toBeTruthy();
  const connected = await probe.eventually(async () => {
    const response = await probe.api(world.den.admin, "/v1/mcp-connections?scope=usable");
    const serialized = JSON.stringify(response.body);
    return serialized.includes(target.id) && serialized.includes('"connectedForMe":true');
  }, {
    within: 90_000,
    intervalMs: 1_000,
    label: "Den connection becomes ready after composer-row OAuth",
    until: (value) => value,
  });
  expect(connected).toBe(true);
  // TODO(primitive): read one named connection row's status and actions.
  const readyRow = await probe.eventually(() => probe.eval(`(targetName) => {
    const title = [...document.querySelectorAll("div")]
      .find((entry) => (entry.textContent ?? "").trim() === targetName && entry.children.length === 0);
    const row = title?.parentElement?.parentElement?.parentElement;
    return {
      ready: (row?.textContent ?? "").includes("Ready"),
      hasSignIn: [...(row?.querySelectorAll("button") ?? [])]
        .some((button) => (button.textContent ?? "").trim() === "Connect your account"),
    };
  }`, { args: [target.name] }), {
    within: 90_000,
    intervalMs: 500,
    label: "target composer connection row becomes ready",
    until: (value) => isRecord(value) && value.ready === true && value.hasSignIn === false,
  });
  expect(readyRow).toEqual({ ready: true, hasSignIn: false });
});
