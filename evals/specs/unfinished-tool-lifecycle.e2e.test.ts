import { spec } from "@openwork/testkit";
import { arrangeControl, unfinishedTools } from "../worlds/chat.ts";

const test = spec.world(unfinishedTools);

test("unfinished current-turn tools expose active, waiting, and unknown outcomes", async ({ world, user, seed, step }) => {
  await step("active unfinished tools remain visibly in progress", async () => {
    await user.see("Running command, reading 1 file");
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "waiting" });
  await step("a blocked unfinished step says what it needs", async () => {
    await user.see({ text: /Waiting for your action/ });
    await user.see({ text: "Choose an option or approve the request to continue." });
    await user.notSee("Running command, reading 1 file");
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "idle" });
  await step("idle unfinished tools expose an unknown terminal state", async () => {
    await user.see({ text: /Status unknown/ });
    await user.see({ text: "No terminal result was observed. This step may still be running; check the session before retrying." });
    await user.notSee({ text: /Waiting for your action/ });
    await user.notSee("Running command, reading 1 file");
  });
});
