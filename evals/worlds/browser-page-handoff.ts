import { startBrowserFixture, type Seed } from "@openwork/env";
import { desktopWithExternalOpenCapture } from "./library.ts";

export async function browserPageHandoff(seed: Seed) {
  const den = await seed.den({ org: { name: "Browser workspace", admin: { name: "Workspace owner" } } });
  const { app, browserUrls } = await desktopWithExternalOpenCapture(seed, den, "admin");
  await seed.workspace(app, seed.tmpPath("browser-page-handoff"), { create: true });
  const session = await seed.session(app, { title: "Account settings" });
  const site = await startBrowserFixture(app, { requireSignIn: false });
  return { app, session, browserUrls, page: site.origin + "/forms", [Symbol.asyncDispose]: () => site[Symbol.asyncDispose]() };
}
