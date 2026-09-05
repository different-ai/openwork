import { createAdmin, createOrg, server } from "../evals/packages/env/src/den.ts";
import type { Den, DenOrgHandle } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";

export const AZURE_BYOK_ORGANIZATION = "Azure BYOK Repro";
export const AZURE_BYOK_ADMIN_EMAIL = "provider-admin@azure-repro.test";

export interface AzureByokWorld {
  den: Den;
  admin: Awaited<ReturnType<typeof createAdmin>>;
  org: DenOrgHandle;
}

/** Fresh isolated self-hosted Den for verifying Azure BYOK delivery. */
export async function bootAzureByok(
  stack: AsyncDisposableStack,
  place: Place,
): Promise<AzureByokWorld> {
  const den = stack.use(await server({ place, provision: false, web: true }));
  const admin = await createAdmin(den, {
    name: "Provider Admin",
    email: AZURE_BYOK_ADMIN_EMAIL,
  });
  const org = stack.use(await createOrg(den, AZURE_BYOK_ORGANIZATION));
  return { den, admin, org };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const { den } = await bootAzureByok(stack, resolvePlace());
  await hold({
    outputs: {
      denWeb: den.ref.webUrl,
      denApi: den.ref.apiUrl,
    },
  });
}

if (import.meta.main) await main();
