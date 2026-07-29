import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  currentDockerPlatform,
  ensureRelease,
  helmUpgradeArgs,
  kubeProfileConfig,
  kubeStackDown,
  manifestSupportsPlatform,
  portForwardArgs,
  resolveKubeImagePlan,
  rolloutStatusArgs,
} from "./kube-stack.ts";
import type { KubeExec, KubeExecOptions, KubeExecResult, KubeImagePlan } from "./kube-stack.ts";

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
