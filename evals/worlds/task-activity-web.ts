import { mkdir, realpath } from "node:fs/promises";
import type { Seed } from "@openwork/env";
import { arrangeControl } from "./chat.ts";

export async function taskActivityWeb(seed: Seed) {
  const path = seed.tmpPath("task-activity-web");
  await mkdir(path, { recursive: true });
  const workspacePath = await realpath(path);
  const app = await seed.appWeb({ name: "task-activity-web", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app, { title: "Delegated activity" });
  await arrangeControl(seed, app, "eval.task_activity.seed", { withFollowup: true });
  return { app, workspace, session };
}
