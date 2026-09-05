import { describe, expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  authenticatedConnectPrompt,
  authenticatedConnectReply,
  suspendedTurn,
  authenticatedConnect,
  suspendedTurnReply,
  stoppedTurnPrompt,
  stoppedTurnReply,
} from "../worlds/thread-recovery.ts";

// The engine is paused with SIGSTOP for longer than the connection guard's
// suspend gap (30s) and then resumed: from the engine's point of view this is
// what an execution pause during sleep looks like. Its model request has gone quiet on a
// socket that will never deliver, so the turn must retry on its own.
const suspendMs = 40_000;
describe("managed provider recovery", () => {
  const test = spec.world(suspendedTurn, { timeout: 180_000, needs: { placement: "local" } });

  test("an in-flight task recovers after sleep without restarting a canceled task", async ({ world, user, probe, step, skip }) => {
    if (process.platform === "win32") return skip("needs: POSIX process suspension");

    await probe.eventually(() => world.completionKinds(), {
      within: 60_000,
      label: "other task is streaming and has gone quiet",
      until: (kinds) => kinds.length === 1 && kinds[0] === "quiet",
    });
    await user.see({ text: /Working/ });
    await user.notSee({ text: suspendedTurnReply }, { timeoutMs: 1_000 });

    await step("the engine sleeps and wakes", () => world.suspendEngine(suspendMs));

    // The quiet request is given up on and re-asked; the turn then runs its
    // tool step and lands its final answer without anyone touching it.
    await probe.eventually(() => world.completionKinds(), {
      within: 90_000,
      label: "engine re-asks the model after resuming and finishes the turn",
      until: (kinds) => kinds.at(-1) === "final",
    });
    await user.see({ text: suspendedTurnReply }, { timeoutMs: 60_000 });
    await probe.eventually(() => world.transcriptFacts(), {
      within: 30_000,
      label: "the completed turn clears its working indicator",
      until: (facts) => !facts.working,
    });
    await user.notSee({ text: /Working/ }, { timeoutMs: 1_000 });
    await user.screenshot();

    // Exactly one re-ask, no duplicated user turn, and nothing left for the
    // user to act on: the retry notice is gone and no interrupted-run card appeared.
    expect(await world.completionKinds()).toEqual(["quiet", "tool", "final"]);
    await user.notSee({ text: /connection lost/i }, { timeoutMs: 1_000 });
    expect(await world.transcriptFacts()).toEqual({ prompts: 1, replies: 1, interruptedCards: 0, working: false });

    // Recovery took longer than its grace period. Cancellation must not retry
    // the other request while the live task resumed on the same engine.
    expect(await world.completionKinds(stoppedTurnPrompt)).toEqual(["quiet"]);
    await user.click({ text: "Stopped turn", exact: true });
    await user.see("Run task");
    await user.notSee({ text: stoppedTurnReply }, { timeoutMs: 1_000 });

  });
});

describe("provider authentication", () => {
  const test = spec.world(authenticatedConnect, { timeout: 180_000, needs: { placement: "local" } });

  test("an authenticated model can call Connect with recovery enabled", async ({ world, user, probe }) => {
    await user.type("composer", authenticatedConnectPrompt);
    await user.click("Run task");
    await probe.eventually(() => world.completionKinds(), {
      within: 60_000,
      label: "authenticated model invokes Connect and finishes",
      until: (kinds) => kinds.at(-1) === "final",
    });
    await user.see({ text: authenticatedConnectReply }, { timeoutMs: 30_000 });
    expect(await world.completionKinds()).toEqual(["tool", "final"]);
    const calls = await world.connectCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ query: "connected apps" });
    await user.notSee({ text: /authentication handler was bypassed|401/ }, { timeoutMs: 1_000 });
    await user.screenshot();
  });
});
