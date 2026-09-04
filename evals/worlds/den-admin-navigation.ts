import type { Seed } from "@openwork/env";

export async function adminDashboardWeb(seed: Seed) {
  const den = await seed.den({
    org: { name: `Admin navigation ${Date.now()}`, admin: { name: "Navigation Admin" } },
  });
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard",
    headless: true,
    viewport: { width: 1440, height: 1100 },
  });
  return { den, web };
}
