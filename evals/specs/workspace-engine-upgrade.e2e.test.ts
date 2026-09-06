import { expect } from "vitest";
import { go } from "@openwork/behaviors";
import { observeTranscript, spec } from "@openwork/testkit";
import { workspaceEngineUpgrade } from "../worlds/chat.ts";

// This journey crosses the engine boundary with an existing workspace. Fresh
// engine chat journeys cannot witness ownership after an upgrade.
const test = spec.world(workspaceEngineUpgrade, { timeout: 420_000 });
const reply = "Hello. Your upgrade conversation is working.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("existing workspaces create usable sessions after changing chat engines", async ({ world, user, probe, step }) => {
  expect((await probe.desktopApi("/experimental/engine-v2-preview/status")).body).toMatchObject({ chatRouting: false });
  await go(world.app, `/workspace/${world.primary.workspaceId}/settings/advanced`);
  await user.see({ text: "OpenCode v2 (preview)" }, { timeoutMs: 30_000 });
  await user.click({ text: "OpenCode v2 (preview)" });
  await probe.eventually(() => probe.desktopApi("/experimental/engine-v2-preview/status"), {
    within: 120_000, label: "v2 configured and running",
    until: (response) => isRecord(response.body) && response.body.running === true && response.body.chatRouting === true,
  });
  await go(world.app, `/workspace/${world.primary.workspaceId}/session`);
  await user.reload();
  await user.see("composer", { timeoutMs: 60_000 });

  await step("create a new chat in the selected existing workspace", async () => {
    await user.click({ role: "button", label: "New session" });
    await probe.eventually(() => probe.hash(), { within: 30_000,
      label: "new session route", until: (hash) => hash.includes("/session/ses_") });
    await user.see("composer", { timeoutMs: 30_000 });
    // Observe the real engine stream without changing requests or responses.
    await probe.eval(`async (workspaceId) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port")
        + "/workspace/" + workspaceId + "/opencode2/api/event", {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("Event witness unavailable: " + response.status);
      const events = [];
      window.__upgradeEventWitness = { events, stop() { clearTimeout(timer); controller.abort(); } };
      void (async () => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split(/\\r?\\n/); buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              let event = JSON.parse(line.slice(5).trim());
              if (typeof event === "string") event = JSON.parse(event);
              if (!event.type) continue;
              events.push(/message|prompt/.test(event.type) ? event : { type: event.type });
            }
          }
        } catch (error) { if (!controller.signal.aborted) events.push({ error: String(error) }); }
      })();
      return true;
    }`, { args: [world.primary.workspaceId], awaitPromise: true });
    await user.type("composer", "hi");
    await using transcript = await observeTranscript(probe, [
      { role: "user", text: "hi" }, { role: "assistant", text: reply },
    ]);
    await user.click("Run task");
    await expect.soft(user.see({ text: "hi" }, { timeoutMs: 2_000 })).resolves.toBeUndefined();
    await user.screenshot();
    await user.see({ text: reply }, { timeoutMs: 90_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.screenshot();
    console.info("[workspace upgrade] native events", JSON.stringify(await probe.eval(`(() => {
      const witness = window.__upgradeEventWitness; witness.stop(); return witness.events;
    })()`)));
    // Soft assertion lets the same run witness sidebar creation as well.
    expect.soft(await transcript.finish()).toMatchObject({ seen: [true, true], violations: [], stopped: false });
  });

  await step("a sidebar new session belongs to the engine that will open it", async () => {
    if (!world.otherName) throw new Error("Existing workspace name missing");
    await user.hover({ role: "button", label: world.otherName });
    // The first New session is global; the revealed workspace plus follows it.
    await user.click({ role: "button", label: "New session", nth: 1 });
    const route = await probe.eventually(() => probe.hash(), { within: 30_000,
      label: "other workspace new session route",
      until: (hash) => hash.includes(`/workspace/${world.other.workspaceId}/session/ses_`),
    });
    const sessionId = route.split("/session/")[1]?.split(/[?#/]/)[0];
    if (!sessionId) throw new Error("Created session route omitted its ID");
    const prefix = `/workspace/${world.other.workspaceId}`;
    const v2 = await probe.desktopApi(`${prefix}/opencode2/api/session/${sessionId}`);
    const v1 = await probe.desktopApi(`${prefix}/opencode/session/${sessionId}`);
    console.info("[workspace upgrade] created-session ownership", JSON.stringify({ sessionId, v1: v1.status, v2: v2.status }));
    await user.screenshot();
    expect.soft(v2.status).toBe(200);
    expect.soft(v1.status).toBe(404);
    await user.notSee({ text: /SessionNotFoundError|Session not found|Session could not be loaded/ });
  });
});
