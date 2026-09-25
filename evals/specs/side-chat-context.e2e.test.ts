import { browserScript, spec } from "@openwork/testkit";
import { expect } from "vitest";
import { sideChatContext } from "../worlds/side-chat-context.ts";

const test = spec.world(sideChatContext, {
  timeout: 240_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("SIDE-01 a side chat reads fresh main-chat decisions after reload and a v2 folder move", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  await user.see("composer", { editable: true });
  const route = await probe.hash();
  const answer = (pane: "primary" | "secondary") => probe.eval(browserScript((pane) => {
    const messages = document.querySelectorAll<HTMLElement>('[data-workbench-pane="' + pane + '"] [data-message-role="assistant"]');
    return [...messages].at(-1)?.innerText ?? "";
  }, [pane]));
  const send = async (pane: "primary" | "secondary", text: string) => {
    await user.type({ placeholder: "Describe your task...", nth: pane === "primary" ? 0 : 1 }, text, { replace: true, verify: true });
    await user.press("Enter");
  };
  const awaitAnswer = (pane: "primary" | "secondary", expected: string) => probe.eventually(() => answer(pane), {
    within: 45_000, label: `${pane} answers from the main conversation's actual decision`, until: text => text.includes(expected),
  }).catch(async (error: unknown) => {
    await user.screenshot();
    const state = await probe.eval(browserScript(() => ({
      panes: [...document.querySelectorAll<HTMLElement>("[data-workbench-pane]")].map(node => ({ pane: node.getAttribute("data-workbench-pane"), text: node.innerText })),
      alerts: [...document.querySelectorAll<HTMLElement>('[role="alert"]')].map(node => node.innerText),
    }), []));
    throw new Error(`${String(error)}; state: ${JSON.stringify(state)}; requests: ${JSON.stringify(await world.requests())}`);
  });
  await step("the side chat receives a fact that only the main chat was told", async () => {
    await send("primary", world.initial);
    await user.see({ text: world.initial, nth: 1 }, { timeoutMs: 45_000 });
    const shortcut = await probe.eval(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform)) ? "Meta+K" : "Control+K";
    await user.press(shortcut);
    await user.type({ placeholder: "Search actions and settings…" }, "new split");
    await user.click({ role: "option", label: /^Open side chat/ });
    await user.see({ placeholder: "Describe your task...", nth: 1 }, { editable: true });
    await send("secondary", world.question);
    await awaitAnswer("secondary", world.initial);
    expect(await probe.hash()).toBe(route);
    expect(await answer("primary")).toContain(world.initial);
    await probe.eventually(() => probe.eval(() => [...document.querySelectorAll("button")]
      .some(button => button.getAttribute("aria-label") === "Stop" || button.textContent?.trim() === "Stop")), {
      within: 15_000, label: "both conversations finish their turns", until: running => !running,
    });
    await user.screenshot();
  });
  await step("the saved side chat gets the latest decision after reload and a main-chat folder move", async () => {
    await world.prepareUpdate();
    await world.moveMain();
    await send("primary", world.updated);
    await awaitAnswer("primary", world.updated);
    await user.reload();
    await user.see({ placeholder: "Describe your task...", nth: 1 }, { editable: true, timeoutMs: 30_000 });
    await send("secondary", world.question);
    await awaitAnswer("secondary", world.updated);
    expect(await probe.hash()).toBe(route);
    expect(await answer("primary")).toContain(world.updated);
    const requests = await world.requests();
    expect(requests.filter(request => request.kind === "tool")).toEqual([]);
    expect(requests.filter(request => request.kind === "final" && request.promptMarker === world.updated)).toHaveLength(2);
    await probe.eventually(() => probe.eval(() => [...document.querySelectorAll("button")]
      .some(button => button.getAttribute("aria-label") === "Stop" || button.textContent?.trim() === "Stop")), {
      within: 15_000, label: "both conversations finish their turns", until: running => !running,
    });
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Side chats receive fresh linked conversation context",
    "The real app reads native main-chat history on each side-chat send. A scripted model answers only when the decision is in its actual input. The decision updates after reload and, on v2, a native main-session directory move. No session-discovery tool is needed; replies stay in their own panes.", true);
});
