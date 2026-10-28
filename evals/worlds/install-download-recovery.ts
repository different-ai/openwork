import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy, type Seed } from "@openwork/env";
import { denRememberLastOrganization } from "./den-remember-last-organization.ts";

export async function installOrganizationChoice(seed: Seed) {
  const world = await denRememberLastOrganization(seed);
  const owner = await seed.web({ den: world.den, signedInAs: world.den.admin, startPath: "/dashboard", headless: true, viewport: { width: 1440, height: 1000 } });
  return { ...world, owner };
}

export async function installDownloadRecovery(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const [api, web] = await allocateFreePorts(2);
  if (!api || !web) throw new Error("Missing isolated install ports");
  const faults = setup.use(await faultProxy({ apiUrl: `http://127.0.0.1:${api}`, webUrl: `http://127.0.0.1:${web}` }));
  const den = setup.use(await seed.den({
    ports: { api, web }, webApiBase: faults.ref.apiUrl, trustedOrigins: [faults.ref.webUrl],
    env: { DEN_ORG_MODE: "single_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true", DEN_SINGLE_ORG_NAME: "Install recovery", DEN_DESKTOP_RELEASES_MODE: "static" },
    seedProfile: "demo-org",
  }));
  await faults.faults.status("/api/den/v1/me/install/", 503, { times: 5, body: { error: "Fixture installer unavailable" } });
  const browser = await seed.web({ den, signedInAs: den.admin, startPath: "/install?token=obsolete-fixture-token", headless: true, viewport: { width: 1440, height: 1200 } });
  const owned = setup.move();
  return { den, web: browser, faults, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
