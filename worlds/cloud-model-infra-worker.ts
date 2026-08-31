import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hold } from "../packages/world/src/hold.ts";
import { launchHeadlessWeb } from "../packages/world/src/headless-web.ts";
import type { HeadlessWebHandle } from "../packages/world/src/headless-web.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
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
 * Launch: `pnpm world up ./worlds/cloud-model-infra-worker.ts`
 * Proof:  `evals/specs/cloud-model-infra.e2e.test.ts`
 */
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
