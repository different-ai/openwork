import { app } from "../evals/packages/env/src/desktop-app.ts";
import type { App } from "../evals/packages/env/src/desktop-app.ts";
import { server } from "../evals/packages/env/src/den.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";

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
    env: { DEN_DASHBOARDS_ENABLED: "true" },
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
      denWeb: output(den.ref.webUrl, { group: "URLs" }),
      denApi: output(den.ref.apiUrl, { group: "URLs" }),
      alexCdp: output(alex.handle.cdpUrl, { group: "URLs" }),
      jordanCdp: output(jordan.handle.cdpUrl, { group: "URLs" }),
      alexEmail: output(den.admin.email, { group: "Accounts", note: "org owner (Acme)" }),
      alexPassword: secret(den.admin.password, { group: "Accounts" }),
      jordan: output("not signed in", { group: "Accounts", note: "fresh desktop, no account" }),
      dashboards: output("enabled", { group: "Org", note: "DEN_DASHBOARDS_ENABLED=true" }),
    },
  });
}

if (import.meta.main) await main();
