import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { savedChat, v2HistoryLockoutRecovery } from "../worlds/v2-history-lockout-recovery.ts";

const test = spec.world(v2HistoryLockoutRecovery, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { commands: ["bun"] },
});

test("a person who used OpenCode v2 for weeks opens OpenWork after an interrupted history copy and finds their chats", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  await step("given an earlier copy left its fence and an engine from an OpenWork that exited still holds the history", async () => {
    const { fence, leftoverEnginePid, leaseOwnerExited } = world.arranged;
    const leftover = world.leftoverEngineRunning();
    evidence.recordAssertionEvidence("The reported interrupted state was arranged before OpenWork started",
      `history-copy.pending present: ${fence}; leftover engine pid ${String(leftoverEnginePid)} running: ${leftover}; its OpenWork exited: ${leaseOwnerExited}`,
      fence && leftover && leaseOwnerExited);
    expect(fence && leftover && leaseOwnerExited).toBe(true);
  });

  await step("after: OpenCode v2 starts instead of reporting \"History migration is incomplete\"", async () => {
    const status = await probe.eventually(() => world.status(), { within: 60_000, label: "OpenCode v2 serves this profile", until: value => value.running });
    const message = status.lastError ?? "none";
    evidence.recordAssertionEvidence("v2 runs with chats routed to it and no history error", `running: ${status.running}; chats on v2: ${status.chatRouting}; last error: ${message}`,
      status.running && status.chatRouting && !/History migration is incomplete/.test(message));
    expect(status.running).toBe(true);
    expect(status.chatRouting).toBe(true);
    expect(message).not.toMatch(/History migration is incomplete|OPENWORK_OPENCODE2_BIN/);
  });

  await step("after: the chat made on OpenCode v2 is listed in the sidebar and opens", async () => {
    await user.see({ text: savedChat.title }, { timeoutMs: 60_000 });
    await user.click({ text: savedChat.title });
    // The session opens without the history-copy error that blocked every start before.
    const readable = await probe.has(savedChat.title);
    evidence.recordAssertionEvidence("The earlier v2 chat opens like any other chat", `"${savedChat.title}" listed and opened; present in the app: ${readable}`, readable);
    expect(readable).toBe(true);
    await user.screenshot();
  });

  await step("the stale fence is gone and the leftover engine was not stopped just to open chats", async () => {
    const fence = await world.fenceRemains();
    const leftover = world.leftoverEngineRunning();
    evidence.recordAssertionEvidence("Opening chats lifts only the abandoned fence and signals no other process",
      `history-copy.pending present: ${fence}; leftover engine still running: ${leftover}`, !fence && leftover);
    expect(fence).toBe(false);
    expect(leftover).toBe(true);
  });
});