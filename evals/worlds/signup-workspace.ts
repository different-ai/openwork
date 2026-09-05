import { createAdmin, type Seed } from "@openwork/env";

export async function signupWorkspace(seed: Seed) {
  const den = await seed.den({ provision: false });
  await createAdmin(den, { name: "Workspace Owner", email: `workspace-owner-${Date.now()}@openwork.test` });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/organization", headless: true, viewport: { width: 1280, height: 1200 } });
  return { den, web, async pathname() {
    const path = await seed.evalIn(web, "window.location.pathname");
    if (typeof path !== "string") throw new Error("Expected browser path");
    return path;
  } };
}
