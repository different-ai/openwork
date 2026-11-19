export const supportedTargets = ["local/host"];

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { queryDenDatabase } from "../../packages/env/src/den.ts";
import { fileURLToPath } from "node:url";
import { hold } from "../../../packages/world/src/hold.ts";
import { launchHeadlessWeb } from "../../../packages/world/src/headless-web.ts";
import type { HeadlessWebHandle } from "../../../packages/world/src/headless-web.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CLOUD_MODEL_INFRA_WORKER_NAME = "cloud-model-infra-worker";
const CLOUD_MODEL_INFRA_WORKER_WORKSPACE = "/tmp/openwork-cloud-model-infra-worker";

export interface CloudModelInfraWorkerOptions {
  name: string;
  workspace: string;
  replace: boolean;
}

/**
 * Worker runtime for the cloud model-infrastructure world: the same
 * source-first openwork-server plus managed OpenCode engine an OpenWork
 * Cloud worker runs, in an isolated workspace.
 *
 * `cloud-model-infra.ts` seeds a Den `worker` whose Daytona signed preview
 * points at this server's `openworkUrl`, so Den's readiness probe, provider
 * materialization, and remote-session capabilities exercise a real worker
 * runtime end to end without a Daytona sandbox.
 *
 * Launch: `pnpm world up ./evals/worlds/infra/cloud-model-infra-worker.ts`
 * Proof:  `evals/specs/cloud-model-infra.e2e.test.ts`
 */
/** Valid Den typeid: prefix plus a 26-char lowercase Crockford suffix whose first char keeps the 128-bit bound. */
function denId(prefix: string): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(26);
  let suffix = "";
  for (let index = 0; index < 26; index += 1) {
    const byte = bytes[index] ?? 0;
    suffix += index === 0 ? String(byte % 8) : alphabet[byte % 32];
  }
  return `${prefix}_${suffix}`;
}

/**
 * Registers this worker runtime in Den as `ownerEmail`'s healthy OpenWork Web
 * computer: a cloud `worker`, its client/host/activity tokens, and a Daytona
 * signed preview pointing at `runtime.url`. This is what provisioning would
 * have written; Den then probes and drives the real runtime. Returns the worker id.
 */
export async function registerWorkerAsCloudComputer(
  databaseUrl: string,
  input: { orgId: string; ownerEmail: string; name: string; sandboxId: string; runtime: { url: string; clientToken: string; hostToken: string } },
): Promise<string> {
  const users = await queryDenDatabase(databaseUrl, "SELECT id FROM `user` WHERE email = ? LIMIT 1", [input.ownerEmail]);
  const first = users[0];
  const ownerUserId = typeof first === "object" && first !== null && "id" in first && typeof first.id === "string" ? first.id : "";
  if (!ownerUserId) throw new Error(`No Den user for ${input.ownerEmail}.`);
  const workerId = denId("wrk");
  await queryDenDatabase(
    databaseUrl,
    `INSERT INTO worker (id, org_id, created_by_user_id, name, description, destination, status, image_version, workspace_path,
       sandbox_backend, last_heartbeat_at, last_active_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'cloud', 'healthy', NULL, NULL, 'cloud-instance', NULL, NULL, NOW(3), NOW(3))`,
    [workerId, input.orgId, ownerUserId, input.name],
  );
  for (const [scope, token] of [["client", input.runtime.clientToken], ["host", input.runtime.hostToken], ["activity", randomBytes(32).toString("hex")]]) {
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO worker_token (id, worker_id, scope, token, created_at, revoked_at) VALUES (?, ?, ?, ?, NOW(3), NULL)",
      [denId("wkt"), workerId, scope, token],
    );
  }
  await queryDenDatabase(
    databaseUrl,
    `INSERT INTO cloud_runtime_instance (id, worker_id, provider_id, provider_ref, workspace_volume_id, data_volume_id,
       endpoint_url, endpoint_expires_at, endpoint_kind, region, created_at, updated_at)
     VALUES (?, ?, 'daytona', ?, 'vol-workspace', 'vol-data', ?, DATE_ADD(NOW(3), INTERVAL 12 HOUR), 'signed-expiring', NULL, NOW(3), NOW(3))`,
    [denId("cri"), workerId, JSON.stringify({ sandboxId: input.sandboxId }), input.runtime.url],
  );
  return workerId;
}

export async function bootCloudModelInfraWorker(
  stack: AsyncDisposableStack,
  options: CloudModelInfraWorkerOptions,
): Promise<HeadlessWebHandle> {
  await mkdir(options.workspace, { recursive: true });
  const handle = await launchHeadlessWeb({
    repoRoot: REPO_ROOT,
    name: options.name,
    state: "isolated",
    workspace: options.workspace,
    replace: options.replace,
  });
  return stack.adopt(handle, (headless) => headless.stop());
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const handle = await bootCloudModelInfraWorker(stack, {
    name: CLOUD_MODEL_INFRA_WORKER_NAME,
    workspace: CLOUD_MODEL_INFRA_WORKER_WORKSPACE,
    replace: false,
  });
  await hold({
    name: CLOUD_MODEL_INFRA_WORKER_NAME,
    outputs: {
      webUrl: handle.manifest.webUrl,
      openworkUrl: handle.manifest.openworkUrl,
      workspace: handle.manifest.workspace,
      runtimeManifest: handle.manifest.runtimeManifestPath,
    },
  });
}

if (import.meta.main) await main();
