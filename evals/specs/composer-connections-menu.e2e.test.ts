import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectionsMenu } from "../worlds/chat.ts";

const test = spec.world(connectionsMenu);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("the composer connections menu scrolls through Den inventory and signs in on the row", async ({ world, user, seed, probe, step, evidence }) => {
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

  await step("find one connection without losing the rest of the inventory", async () => {
    await user.type({ label: "Find a connection" }, target.name.toUpperCase());
    await user.see({ text: target.name });
    await user.notSee({ text: world.connections[0].name });
    await user.type({ label: "Find a connection" }, "no-such-connection", { replace: true });
    await user.see({ text: "No matches in this workspace. Try a different word or clear your search." });
    await user.notSee({ text: target.name });
    await user.click("Clear search");
    // TODO(primitive): assert keyboard focus on a named input.
    expect(await probe.eval(`document.activeElement?.getAttribute("aria-label")`)).toBe("Find a connection");
    await user.see({ text: world.connections[0].name });
    await user.type({ label: "Find a connection" }, target.name, { replace: true });
    await user.screenshot();
    evidence.recordAssertionEvidence("Connection discovery narrows by name and recovers from no matches",
      "Uppercase query found only the target; a missing name hid the target; Clear search restored inventory.", true);
  });

  const connectStartedAt = new Date().toISOString();
  await user.click({ role: "button", label: "Connect your account" });
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
  evidence.recordAssertionEvidence("Filtered connection signs in within the composer", JSON.stringify(readyRow), true);

  await step("discover a skill by the work it does and add it to an unsent draft", async () => {
    await user.click({ role: "button", label: "Skills" });
    await user.see({ role: "button", label: `Use in task ${world.skillName}` });
    await user.see({ role: "button", label: `Use in task ${world.otherSkillName}` });
    await user.type({ label: "Find a skill by name or what it does" }, "meeting");
    await user.see({ role: "button", label: `Use in task ${world.skillName}` });
    await user.notSee({ role: "button", label: `Use in task ${world.otherSkillName}` });
    await user.see({ text: "Prepare a meeting briefing from project notes and open questions." });
    await user.screenshot();
    // Clear the active search, then close the popover before editing the draft beneath it.
    await user.press("Escape");
    await user.press("Escape");
    await user.notSee({ label: "Find a skill by name or what it does" });
    const draft = "Help me prepare for tomorrow.";
    const draftText = /Help me prepare for tomorrow\./;
    await user.type("composer", draft);
    // TODO(primitive): inspect the current task's persisted message count through the engine boundary.
    const taskSnapshot = () => probe.eval(`async (sessionId) => {
      const workspaceId = location.hash.match(/^#\\/workspace\\/([^/]+)\\/session\\//)?.[1];
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      if (!workspaceId || !port || !token) throw new Error("Task transport is not ready.");
      const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + workspaceId + "/opencode/session/" + encodeURIComponent(sessionId) + "/message", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!response.ok) throw new Error("Task message read failed: " + response.status);
      const messages = await response.json();
      if (!Array.isArray(messages)) throw new Error("Task message response was not a list.");
      return { route: location.hash, messages: messages.length };
    }`, { args: [world.session.sessionId], awaitPromise: true });
    const beforeSelection = await taskSnapshot();
    expect(beforeSelection).toMatchObject({ messages: 0 });
    await user.click({ role: "button", label: "Agents, commands, skills, plugins, and connections" });
    await user.see({ role: "button", label: `Use in task ${world.skillName}` });
    await user.click({ role: "button", label: `Use in task ${world.skillName}` });
    await user.see("composer", { editable: true, text: draftText });
    await user.see("composer", { text: new RegExp(world.skillName) });
    await user.notSee({ label: "Find a skill by name or what it does" });
    await user.screenshot();
    const afterSelection = await taskSnapshot();
    expect(afterSelection).toEqual(beforeSelection);
    evidence.recordAssertionEvidence("Skill descriptions lead to an editable task draft without submitting",
      `Description query meeting showed ${world.skillName} and hid ${world.otherSkillName}; selecting preserved the draft and added the skill chip. Task snapshot: ${JSON.stringify(afterSelection)}.`, true);

    await user.click({ role: "button", label: "Agents, commands, skills, plugins, and connections" });
    await user.type({ label: "Find a skill by name or what it does" }, "no-matching-skill");
    await user.notSee({ role: "button", label: `Use in task ${world.skillName}` });
    await user.press("Escape");
    await user.see({ role: "button", label: `Use in task ${world.skillName}` });
    await user.see({ role: "button", label: `Use in task ${world.otherSkillName}` });
    await user.press("Escape");
    await user.notSee({ label: "Find a skill by name or what it does" });
    // TODO(primitive): assert focus returns to the editable composer.
    expect(await probe.eval(`document.activeElement?.getAttribute("contenteditable")`)).toBe("true");
    await user.see("composer", { text: draftText });
    evidence.recordAssertionEvidence("Escape clears a search before closing discovery and restoring composer focus",
      "First Escape restored both skills; second closed the menu, focused the composer, and retained the draft.", true);
  });
});
