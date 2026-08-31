import { denFetch } from "../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../evals/packages/behaviors/src/den.ts";
import { createAdmin, createOrg, server } from "../evals/packages/env/src/den.ts";
import type { Den, DenOrgHandle } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";

export const CLOUD_MODEL_INFRA_ORG = "Cloud Model Infra";
export const CLOUD_MODEL_INFRA_ADMIN_EMAIL = "infra-admin@cloud-model-infra.test";
export const CLOUD_MODEL_INFRA_GATEWAY_KEY = "cloud-model-infra-gateway-key";
export const CLOUD_MODEL_INFRA_DAYTONA_KEY = "cloud-model-infra-daytona-guard-key";

export interface CloudModelInfraOptions {
  daytonaApiUrl: string;
}

export interface CloudModelInfraWorld {
  den: Den;
  admin: DenSession;
  org: DenOrgHandle;
}

async function enableCloudCapability(admin: DenSession, organizationId: string): Promise<void> {
  const route = `/v1/admin/organizations/${organizationId}/capabilities`;
  const result = await denFetch(admin, route, {
    method: "PUT",
    headers: { authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ capabilities: { cloud: true } }),
  });
  if (!result.response.ok) {
    throw new Error(`PUT ${route} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

/**
 * Cloud model-infrastructure world: a fresh self-hosted Den whose only
 * organization is Cloud-enabled (`capabilities.cloud`) and whose Daytona
 * provisioner gate is satisfied without any real Daytona account.
 *
 * `DAYTONA_API_URL` deliberately points at an unroutable local address: the
 * healthy-worker runtime path (signed-preview probe, gateway resolve,
 * provider materialization, remote-session capabilities) must never call the
 * Daytona SDK. Any unexpected SDK call fails fast instead of reaching the
 * real Daytona API. The proof spec replaces this URL with a live request
 * ledger and asserts it stays empty.
 *
 * The member-owned cloud worker itself is seeded at the database seam
 * (`worker`, `worker_token`, `daytona_sandbox`) pointing at a real
 * source-first openwork-server launched from `cloud-model-infra-worker.ts`,
 * so Den talks to a genuine worker runtime over plain HTTP.
 *
 * Launch: `pnpm world up ./worlds/cloud-model-infra.ts`
 * Proof:  `evals/specs/cloud-model-infra.e2e.test.ts`
 */
export async function bootCloudModelInfra(
  stack: AsyncDisposableStack,
  place: Place,
  options: CloudModelInfraOptions,
): Promise<CloudModelInfraWorld> {
  const den = stack.use(await server({
    place,
    provision: false,
    web: true,
    env: {
      PROVISIONER_MODE: "daytona",
      DAYTONA_API_KEY: CLOUD_MODEL_INFRA_DAYTONA_KEY,
      DAYTONA_API_URL: options.daytonaApiUrl,
      DEN_GATEWAY_KEY: CLOUD_MODEL_INFRA_GATEWAY_KEY,
      DEN_BOOTSTRAP_ADMIN_EMAILS: CLOUD_MODEL_INFRA_ADMIN_EMAIL,
    },
  }));
  const admin = await createAdmin(den, {
    name: "Infra Admin",
    email: CLOUD_MODEL_INFRA_ADMIN_EMAIL,
  });
  const org = stack.use(await createOrg(den, CLOUD_MODEL_INFRA_ORG));
  await enableCloudCapability(admin, org.id);
  return { den, admin, org };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const place = resolvePlace();
  const { den } = await bootCloudModelInfra(stack, place, {
    daytonaApiUrl: "http://127.0.0.1:9/daytona-guard",
  });
  await hold({
    outputs: {
      denWeb: den.ref.webUrl,
      denApi: den.ref.apiUrl,
    },
  });
}

if (import.meta.main) await main();
