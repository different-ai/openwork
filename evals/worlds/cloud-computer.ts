import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/** The real Web app, signed in to an organization.
 * This world deliberately has no desktop image: it proves the recovery UI,
 * while the provider check exercises the actual Daytona desktop separately. */
export async function cloudComputerWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Cloud computer studio", admin: { name: "Workspace Owner" } } });
  const { app } = await signedInAppWeb(seed, { name: "cloud-computer", den, webPort, workspacePath: seed.tmpPath("cloud-computer-workspace") });
  const session = await seed.session(app, { title: "Work in the cloud browser" });
  return { app, den, session };
}
