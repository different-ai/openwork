import { seedSessions } from "../evals/packages/behaviors/src/sessions.ts";
import { app } from "../evals/packages/env/src/desktop-app.ts";
import type { App } from "../evals/packages/env/src/desktop-app.ts";
import { createAdmin, createOrg, server } from "../evals/packages/env/src/den.ts";
import type { Den, DenOrgHandle } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";

export interface SoloOptions {
  sessions?: readonly string[];
  workspacePath?: string;
  profileDir?: string;
}

export interface SoloWorld {
  den: Den;
  org: DenOrgHandle;
  desktop: App;
  sessions: { sessionId: string; title: string }[];
}

/** One fresh organization and one signed-in desktop workspace. */
export async function bootSolo(
  stack: AsyncDisposableStack,
  place: Place,
  options: SoloOptions = {},
): Promise<SoloWorld> {
  const den = stack.use(await server({ place, provision: false, web: true }));
  await createAdmin(den, {});
  const org = stack.use(await createOrg(den, "acme"));
  const desktop = stack.use(await app({
    den,
    place,
    as: "admin",
    ...(options.workspacePath === undefined ? {} : { workspacePath: options.workspacePath }),
    ...(options.profileDir === undefined ? {} : { profileDir: options.profileDir }),
  }));
  const sessions = options.sessions ? await seedSessions(desktop, options.sessions) : [];
  return { den, org, desktop, sessions };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const { den, desktop } = await bootSolo(stack, resolvePlace());
  await hold({
    name: "solo",
    outputs: {
      denWeb: den.ref.webUrl,
      denApi: den.ref.apiUrl,
      cdp: desktop.handle.cdpUrl,
    },
  });
}

if (import.meta.main) await main();
