import { startBrowserFixture, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export async function browserAddressBar(seed: Seed) {
  const den = await seed.den({ org: { name: "Browser workspace", admin: { name: "Workspace owner" } } });
  const app = await seed.desktop({ den, as: "admin" });
  await seed.workspace(app, seed.tmpPath("browser-address-bar"), { create: true });
  const session = await seed.session(app, { title: "Website research" });
  const site = await startBrowserFixture(app, { requireSignIn: false });
  return {
    app, session, page: site.origin + "/forms",
    enableSearch: () => enableOrganizationCapabilities(seed, den.admin, { browserAddressSearch: true }),
    [Symbol.asyncDispose]: () => site[Symbol.asyncDispose](),
  };
}
