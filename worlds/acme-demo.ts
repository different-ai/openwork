import { app } from "../evals/packages/env/src/desktop-app.ts";
import type { App } from "../evals/packages/env/src/desktop-app.ts";
import { server } from "../evals/packages/env/src/den.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";

export interface AcmeDemoWorld {
  den: Den;
  alex: App;
  jordan: App;
}

/** The seeded Acme demo with Alex signed in and Jordan on a fresh profile. */
export async function bootAcmeDemo(
  stack: AsyncDisposableStack,
  place: Place,
): Promise<AcmeDemoWorld> {
  const den = stack.use(await server({
    place,
    ports: { api: 8790, web: 3005 },
    seedProfile: "demo-org",
    web: true,
  }));
  const alex = stack.use(await app({ den, place, as: "admin" }));
  const jordan = stack.use(await app({ den, place, signIn: false }));
  return { den, alex, jordan };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const { den, alex, jordan } = await bootAcmeDemo(stack, resolvePlace());
  await hold({
    name: "acme-demo",
    outputs: {
      denWeb: den.ref.webUrl,
      denApi: den.ref.apiUrl,
      alexCdp: alex.handle.cdpUrl,
      jordanCdp: jordan.handle.cdpUrl,
    },
  });
}

if (import.meta.main) await main();
