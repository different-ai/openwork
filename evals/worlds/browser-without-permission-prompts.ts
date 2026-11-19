import { startBrowserFixture } from "@openwork/env";
import type { Seed } from "@openwork/env";

export async function browserWithoutPermissionPrompts(seed: Seed) {
  const app = await seed.desktop({ name: "browser-without-prompts" });
  await seed.workspace(app, seed.tmpPath("browser-without-prompts"), { create: true });
  const neighbor = await seed.session(app, { title: "Separate browser research" });
  const session = await seed.session(app, { title: "Browser project" });
  const fixture = await startBrowserFixture(app, { requireSignIn: false });
  return {
    app, session, neighbor, origin: fixture.origin,
    async [Symbol.asyncDispose]() { await fixture[Symbol.asyncDispose](); },
  };
}
