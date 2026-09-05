import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  currentDockerPlatform,
  ensureKindDenReady,
  ensureRelease,
  exposeEndpointHandles,
  helmUpgradeArgs,
  kubeProfileConfig,
  kubeStackDown,
  manifestSupportsPlatform,
  portForwardArgs,
  resolveKubeImagePlan,
  rolloutStatusArgs,
} from "../src/kind-stack.ts";
import type { KubeExec, KubeExecOptions, KubeExecResult, KubeImagePlan, KubeSpawnDetached } from "../src/kind-stack.ts";

interface ExecCall {
  command: string;
  args: string[];
  options?: KubeExecOptions;
}

function success(stdout = ""): KubeExecResult {
  return { stdout, stderr: "", code: 0 };
}

function createExec(handler: (call: ExecCall) => KubeExecResult): { exec: KubeExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: KubeExec = async (command, args, options) => {
    const call = { command, args: [...args], options };
    calls.push(call);
    return handler(call);
  };
  return { exec, calls };
}

function imagePlan(mode: "published" | "local"): KubeImagePlan {
  return {
    mode,
    denApiRepository: mode === "local" ? "openwork-den-api" : "ghcr.io/different-ai/openwork-den-api",
    denWebRepository: mode === "local" ? "openwork-den-web" : "ghcr.io/different-ai/openwork-den-web",
    tag: mode === "local" ? "kube-lab" : "latest",
    pullPolicy: "IfNotPresent",
    reason: "test",
  };
}

function manifestFor(architecture: string): unknown {
  return { manifests: [{ platform: { os: "linux", architecture } }] };
}

function withCleanImageEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENWORK_EVAL_KUBE_IMAGES;
  delete process.env.OPENWORK_EVAL_KUBE_IMAGES;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.OPENWORK_EVAL_KUBE_IMAGES;
    else process.env.OPENWORK_EVAL_KUBE_IMAGES = previous;
  });
}

test("kube profile selection maps values files and org modes", () => {
  assert.deepEqual(kubeProfileConfig("single-org"), {
    profile: "single-org",
    orgMode: "single_org",
    valuesPath: "evals/fixtures/kube/values/single-org.yaml",
  });
  assert.deepEqual(kubeProfileConfig("multi-org"), {
    profile: "multi-org",
    orgMode: "multi_org",
    valuesPath: "evals/fixtures/kube/values/multi-org.yaml",
  });
});

test("helm upgrade argv includes release, chart, profile, context, and local image overrides", () => {
  const args = helmUpgradeArgs(kubeProfileConfig("multi-org"), imagePlan("local"));

  assert.deepEqual(args.slice(0, 7), [
    "upgrade",
    "--install",
    "openwork-ee",
    "packaging/helm/openwork-ee",
    "-f",
    "evals/fixtures/kube/values/multi-org.yaml",
    "--set",
  ]);
  assert(args.includes("image.tag=kube-lab"));
  assert(args.includes("image.pullPolicy=IfNotPresent"));
  assert(args.includes("denApi.image.repository=openwork-den-api"));
  assert(args.includes("denWeb.image.repository=openwork-den-web"));
  assert(args.includes("--kube-context"));
  assert(args.includes("kind-openwork-kube-lab"));
});

test("kubectl rollout and port-forward argv use the kind context", () => {
  assert.deepEqual(rolloutStatusArgs("openwork-ee-den-api", "300s"), [
    "--context",
    "kind-openwork-kube-lab",
    "rollout",
    "status",
    "deployment/openwork-ee-den-api",
    "--timeout=300s",
  ]);
  assert.deepEqual(portForwardArgs("openwork-ee-den-web", 3005, 3005), [
    "--context",
    "kind-openwork-kube-lab",
    "port-forward",
    "service/openwork-ee-den-web",
    "3005:3005",
  ]);
});

test("published image decision uses manifest platform support", async () => {
  await withCleanImageEnv(async () => {
    const platform = currentDockerPlatform();
    assert.equal(manifestSupportsPlatform(manifestFor(platform.architecture), platform), true);
    assert.equal(manifestSupportsPlatform(manifestFor("s390x"), platform), false);

    const { exec, calls } = createExec(() => success(JSON.stringify(manifestFor(platform.architecture))));
    const plan = await resolveKubeImagePlan({ exec });

    assert.equal(plan.mode, "published");
    assert.equal(calls.filter((call) => call.command === "docker" && call.args.join(" ").includes("manifest inspect")).length, 2);
  });
});

test("local image decision skips manifest inspection when explicitly requested", async () => {
  await withCleanImageEnv(async () => {
    const { exec, calls } = createExec(() => {
      throw new Error("manifest inspection should not run");
    });

    const plan = await resolveKubeImagePlan({ exec, images: "local" });

    assert.equal(plan.mode, "local");
    assert.equal(calls.length, 0);
  });
});

test("explicit published image mode fails when manifests do not support this platform", async () => {
  await withCleanImageEnv(async () => {
    const { exec } = createExec(() => success(JSON.stringify(manifestFor("s390x"))));

    await assert.rejects(
      () => resolveKubeImagePlan({ exec, images: "published" }),
      /Published Den images do not advertise/,
    );
  });
});

test("endpoint handles return credentials and stop only their recorded port-forwards", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openwork-kind-endpoints-test-"));
  const spawned: { command: string; args: string[]; pid: number }[] = [];
  const killed: number[] = [];
  const pids = [987_651, 987_652];
  const spawnDetached: KubeSpawnDetached = (command, args) => {
    const pid = pids[spawned.length];
    if (pid === undefined) throw new Error("Unexpected extra detached process.");
    spawned.push({ command, args: [...args], pid });
    return pid;
  };
  const { exec } = createExec((call) => call.command === "lsof"
    ? { stdout: "", stderr: "", code: 1 }
    : success());
  const previousFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    fetchedUrls.push(url);
    if (url.endsWith("/api/auth/sign-in/email")) {
      return new Response(JSON.stringify({ token: "kind-owner-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok", { status: 200 });
  };
  const envBefore = {
    apiUrl: process.env.OPENWORK_EVAL_DEN_API_URL,
    webUrl: process.env.OPENWORK_EVAL_DEN_WEB_URL,
    token: process.env.OPENWORK_EVAL_DEN_TOKEN,
    multiOrg: process.env.OPENWORK_EVAL_DEN_MULTI_ORG,
  };
  globalThis.fetch = fakeFetch;
  try {
    const endpoints = await exposeEndpointHandles(kubeProfileConfig("single-org"), {
      stateDir,
      exec,
      spawnDetached,
      sleep: async () => undefined,
      killProcess: (pid) => killed.push(pid),
    });

    assert.equal(endpoints.apiUrl, "http://127.0.0.1:8790");
    assert.equal(endpoints.webUrl, "http://127.0.0.1:3005");
    assert.equal(endpoints.token, "kind-owner-token");
    assert.equal(endpoints.adminEmail, "alex@acme.test");
    assert(fetchedUrls.includes("http://127.0.0.1:3005/api/ready"));
    assert(!fetchedUrls.includes("http://127.0.0.1:3005/api/den/health"));
    assert.deepEqual(spawned.map(({ command, pid }) => ({ command, pid })), [
      { command: "kubectl", pid: 987_651 },
      { command: "kubectl", pid: 987_652 },
    ]);
    assert.equal(await readFile(join(stateDir, "api-port-forward.pid"), "utf8"), "987651");
    assert.equal(await readFile(join(stateDir, "web-port-forward.pid"), "utf8"), "987652");

    await endpoints.stop();
    await endpoints.stop();

    assert.deepEqual(killed, [-987_651, 987_651, -987_652, 987_652]);
    await assert.rejects(() => readFile(join(stateDir, "api-port-forward.pid"), "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(join(stateDir, "web-port-forward.pid"), "utf8"), /ENOENT/);
    assert.deepEqual({
      apiUrl: process.env.OPENWORK_EVAL_DEN_API_URL,
      webUrl: process.env.OPENWORK_EVAL_DEN_WEB_URL,
      token: process.env.OPENWORK_EVAL_DEN_TOKEN,
      multiOrg: process.env.OPENWORK_EVAL_DEN_MULTI_ORG,
    }, envBefore);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("endpoint acquisition failure stops both newly started port-forwards", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openwork-kind-endpoints-failure-test-"));
  const killed: number[] = [];
  const pids = [987_661, 987_662];
  let spawned = 0;
  const spawnDetached: KubeSpawnDetached = () => {
    const pid = pids[spawned];
    spawned += 1;
    if (pid === undefined) throw new Error("Unexpected extra detached process.");
    return pid;
  };
  const { exec } = createExec((call) => call.command === "lsof"
    ? { stdout: "", stderr: "", code: 1 }
    : success());
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    return new Response(url.endsWith("/api/auth/sign-in/email") ? "no" : "ok", {
      status: url.endsWith("/api/auth/sign-in/email") ? 401 : 200,
    });
  };
  try {
    await assert.rejects(
      () => exposeEndpointHandles(kubeProfileConfig("single-org"), {
        stateDir,
        exec,
        spawnDetached,
        sleep: async () => undefined,
        killProcess: (pid) => killed.push(pid),
      }),
      /Could not obtain a demo-owner session.*HTTP 401/,
    );

    assert.deepEqual(killed, [-987_662, 987_662, -987_661, 987_661]);
    await assert.rejects(() => readFile(join(stateDir, "api-port-forward.pid"), "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(join(stateDir, "web-port-forward.pid"), "utf8"), /ENOENT/);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("ensureKindDenReady fails fast when the shared kind cluster is absent", async () => {
  const { exec, calls } = createExec(() => success(""));

  await assert.rejects(
    () => ensureKindDenReady({ exec }),
    /ensureKubeStack\(\{ cdpCandidates: \[\], skipApp: true \}\)/,
  );
  assert.deepEqual(calls.map((call) => `${call.command} ${call.args.join(" ")}`), ["kind get clusters"]);
});

test("ensureKindDenReady verifies both Den rollouts before reading shared state", async () => {
  const { exec, calls } = createExec((call) => {
    const text = `${call.command} ${call.args.join(" ")}`;
    if (text === "kind get clusters") return success("openwork-kube-lab\n");
    if (text.includes("SHOW TABLES LIKE")) {
      return success("organization\ndesktop_connect_grant\nscim_group\ngroup_mapping_mode\n");
    }
    if (text.includes("SELECT id FROM `user`")) return success("seeded-owner-id\n");
    return success();
  });

  await ensureKindDenReady({ exec });

  const commands = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
  const apiRollout = commands.findIndex((command) => command.includes("rollout status deployment/openwork-ee-den-api"));
  const webRollout = commands.findIndex((command) => command.includes("rollout status deployment/openwork-ee-den-web"));
  const schemaQuery = commands.findIndex((command) => command.includes("SHOW TABLES LIKE"));
  assert(apiRollout >= 0);
  assert(webRollout > apiRollout);
  assert(schemaQuery > webRollout);
});

test("kubeStackDown stops port-forwards before uninstalling the release", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openwork-kube-stack-test-"));
  const order: string[] = [];
  const { exec } = createExec((call) => {
    order.push(`${call.command}:${call.args[0] ?? ""}`);
    return success();
  });
  try {
    await writeFile(join(stateDir, "api-port-forward.pid"), "111");
    await writeFile(join(stateDir, "web-port-forward.pid"), "222");
    await kubeStackDown({
      stateDir,
      exec,
      sleep: async () => undefined,
      killProcess: (pid) => {
        order.push(`kill:${pid}`);
      },
    });

    const firstHelm = order.findIndex((entry) => entry === "helm:uninstall");
    assert(firstHelm > 0, `expected helm uninstall after kills, got ${order.join(", ")}`);
    assert(order.slice(0, firstHelm).some((entry) => entry === "kill:-111"));
    assert(order.slice(0, firstHelm).some((entry) => entry === "kill:111"));
    assert(order.slice(0, firstHelm).some((entry) => entry === "kill:-222"));
    assert(order.slice(0, firstHelm).some((entry) => entry === "kill:222"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("rollout failure surfaces pod status and recent logs", async () => {
  const { exec } = createExec((call) => {
    const text = `${call.command} ${call.args.join(" ")}`;
    if (text.includes("helm upgrade")) return success("release upgraded");
    if (text.includes("rollout status deployment/openwork-ee-den-api")) return { stdout: "", stderr: "rollout failed", code: 1 };
    if (text.includes("get pods")) return success("pod/openwork-ee-den-api pending");
    if (text.includes("describe pods")) return success("Events: image pull backoff");
    if (text.includes("logs")) return success("pod log line: config missing");
    return success();
  });

  await assert.rejects(
    () => ensureRelease(kubeProfileConfig("single-org"), imagePlan("published"), { exec }),
    /pod log line: config missing/,
  );
});
