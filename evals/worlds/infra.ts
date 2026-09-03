import { mkdir } from "node:fs/promises";
import type { Seed } from "@openwork/env";
import {
  createDaytonaK3sCluster,
  createPlacement,
  kindServer,
  KUBE_CLUSTER_NAME,
  KUBE_CONTEXT,
  provisionDaytonaK3sSandbox,
  SkipError,
  server,
} from "@openwork/env";
import type { Place } from "@openwork/env";
import { app } from "@openwork/env";
import { daytonaSandbox, desktop } from "@openwork/hosts";
import { bootRemoteSession } from "../../worlds/remote-session.ts";
import { bootCloudModelInfra } from "../../worlds/cloud-model-infra.ts";
import { signIn as signInDen } from "@openwork/behaviors";

export async function emptyInfraWorld(_seed: Seed) {
  return {};
}

export async function oauthDenWorld(seed: Seed) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) throw new SkipError("The opencode OAuth proof requires a cold managed Den");
  const den = await seed.den({
    org: { name: "OAuth Lab", admin: { name: "OAuth Admin" }, members: {} },
  });
  return { den };
}

export async function twoDaytonaDesktopsWorld(seed: Seed) {
  const requestedA = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_A?.trim();
  const requestedB = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX_B?.trim();
  if (Boolean(requestedA) !== Boolean(requestedB)) throw new Error("Set both Daytona sandbox ids or neither.");
  if (requestedA && requestedA === requestedB) throw new Error("The two Daytona sandbox ids must differ.");
  const appA = requestedA
    ? await desktop({ host: daytonaSandbox(requestedA), name: "a" })
    : await seed.desktop({ name: "a" });
  const appB = requestedB
    ? await desktop({ host: daytonaSandbox(requestedB), name: "b" })
    : await seed.desktop({ name: "b" });
  const sandboxA = appA.handle.sandboxId;
  const sandboxB = appB.handle.sandboxId;
  if (!sandboxA || !sandboxB) throw new Error("Both desktops must run in Daytona sandboxes.");
  if (sandboxA === sandboxB) throw new Error("The two Daytona sandbox ids must differ.");
  const stamp = Date.now();
  const [workspaceA, workspaceB] = await Promise.all([
    seed.workspace(appA, `/tmp/openwork-two-sandboxes-a-${stamp}`),
    seed.workspace(appB, `/tmp/openwork-two-sandboxes-b-${stamp}`),
  ]);
  return {
    appA,
    appB,
    sandboxA,
    sandboxB,
    workspaceA,
    workspaceB,
    async [Symbol.asyncDispose]() {
      await Promise.all([appA[Symbol.asyncDispose](), appB[Symbol.asyncDispose]()]);
    },
  };
}

export async function localDenSelfTestWorld(_seed: Seed, { place }: { place: Place }) {
  const den = await server({ place });
  if (!den.database || !den.ports) throw new Error("Local server did not expose its database and ports.");
  const signedIn = await signInDen(den.ref, den.admin);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await den[Symbol.asyncDispose]();
  };
  return { den, database: den.database, ports: den.ports, signedIn, close, [Symbol.asyncDispose]: close };
}

export async function remoteSessionServerWorld(_seed: Seed) {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test";
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32);
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790";
  process.env.DEN_API_PUBLIC_URL ??= "http://127.0.0.1:8790";
  const module = await import("../../ee/apps/den-api/src/mcp/remote-session-capabilities.js");
  const workspace = "/tmp/openwork-remote-session-world";
  await mkdir(workspace, { recursive: true });
  const stack = new AsyncDisposableStack();
  const headless = await bootRemoteSession(stack, {
    name: `remote-session-e2e-${process.pid}`,
    workspace,
    replace: true,
  });
  const close = () => stack.disposeAsync();
  return { headless, module, close, [Symbol.asyncDispose]: close };
}

export async function cloudModelInfraWorld(_seed: Seed, { place }: { place: Place }) {
  const stack = new AsyncDisposableStack();
  const cloud = await bootCloudModelInfra(stack, place, { daytonaApiUrl: "http://127.0.0.1:9/daytona-guard" });
  return { cloud, stack, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
}

export async function remoteSessionRunnerWorld(_seed: Seed, { place }: { place: Place }) {
  const stack = new AsyncDisposableStack();
  const cloud = await bootCloudModelInfra(stack, place, { daytonaApiUrl: "http://127.0.0.1:9/daytona-guard" });
  const workspace = "/tmp/openwork-remote-session-world";
  await mkdir(workspace, { recursive: true });
  const worker = await bootRemoteSession(stack, {
    name: `remote-session-runner-worker-${process.pid}`,
    workspace,
    replace: true,
  });
  return { cloud, worker, stack, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
}

export {
  app,
  bootCloudModelInfra,
  bootRemoteSession,
  createDaytonaK3sCluster,
  createPlacement,
  daytonaSandbox,
  desktop,
  kindServer,
  KUBE_CLUSTER_NAME,
  KUBE_CONTEXT,
  provisionDaytonaK3sSandbox,
  server,
};
export { denFetch, signIn } from "@openwork/behaviors";
export type { DenSession } from "@openwork/behaviors";
export { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths, stopHeadlessRuntime } from "@openwork/world";
export { createDesktopAutomationRunner } from "../../apps/desktop/electron/automation-runner.mjs";
export { bootDevHeadless } from "../../worlds/dev-headless.ts";
export type {
  RemoteSessionExecuteInput,
  RemoteSessionRuntime,
  RemoteSessionRuntimeResult,
  RemoteSessionToolResult,
} from "../../ee/apps/den-api/src/mcp/remote-session-capabilities.js";
