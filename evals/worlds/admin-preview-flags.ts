import type { Seed } from "@openwork/env";

/** /admin › Preview flags on a real Den, opened by the platform administrator. */
export async function adminPreviewFlagsWorld(seed: Seed) {
  const den = await seed.den({ web: true, org: { name: "Preview flags workspace", admin: { name: "Platform administrator" }, members: {} } });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/features", headless: true, viewport: { width: 1280, height: 900 } });
  return { den, web };
}
export const supportedTargets = ["local/host"];
