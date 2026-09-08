import type { Seed } from "@openwork/env";
import { signupWorkspace } from "../../evals/worlds/signup-workspace.ts";

export async function onboardingWorld(seed: Seed) {
  const directory =
    process.env.OPENWORK_EVAL_FILM_DIR || seed.tmpPath("onboarding-film");
  const world = await signupWorkspace(seed, {
    filmDirectory: directory,
    viewport: { width: 1600, height: 940 },
  });
  world.owner.name = "Alex";
  world.owner.email = "alex@openwork.test";
  world.owner.password = "OpenWork-demo-9274!";
  return { ...world, directory };
}
