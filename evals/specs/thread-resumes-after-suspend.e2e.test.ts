import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { suspendedTurn, suspendedTurnPrompt, suspendedTurnReply } from "../worlds/chat.ts";

// The engine is paused with SIGSTOP for longer than the connection guard's
// suspend gap (30s) and then resumed: from the engine's point of view this is
// exactly what closing the lid does. Its model request has gone quiet on a
// socket that will never deliver, so the turn must retry on its own.
const suspendMs = 40_000;
const test = spec.world(suspendedTurn, { timeout: 300_000 });

test("a turn that goes quiet while the computer sleeps resumes on its own", async ({ world, user, probe, step }) => {
  if (process.platform === "win32") return;

  await user.type("composer", suspendedTurnPrompt);
  await user.click("Run task");
  await probe.eventually(() => world.completionKinds(), {
    within: 60_000,
    label: "first model request is streaming and has gone quiet",
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
  await user.notSee({ text: /Working/ }, { timeoutMs: 15_000 });
  await user.screenshot();

  // Exactly one re-ask, no duplicated user turn, and nothing left for the
  // user to act on: the retry notice is gone and no interrupted-run card appeared.
  expect(await world.completionKinds()).toEqual(["quiet", "tool", "final"]);
  await user.notSee({ text: /connection lost/i }, { timeoutMs: 1_000 });
  expect(await world.transcriptFacts()).toEqual({ prompts: 1, replies: 1, interruptedCards: 0 });
});
