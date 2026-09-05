import assert from "node:assert/strict";
import test from "node:test";
import type { DaytonaExec } from "@openwork/hosts";
import {
  createDaytonaK3sCluster,
  exposeK3sService,
  installK3sHelmRelease,
  parseDaytonaK3sPreviewUrl,
  provisionDaytonaK3sSandbox,
} from "../src/daytona-k3s.ts";
import { createPlacement } from "../src/network-world.ts";
import type { DaytonaK3sClusterHandle, DaytonaK3sSandboxOwnership } from "../src/daytona-k3s.ts";
import type { Placement } from "../src/network-world.ts";

interface ExecCall {
  args: string[];
  opts?: { input?: string; timeoutMs?: number };
}

interface FakeOptions {
  uid?: string;
  sudoFails?: boolean;
  failAt?: "sandbox-create" | "sandbox-readiness" | "install" | "start" | "readiness" | "preview";
  helmMissing?: boolean;
}

const SANDBOX = "owned-sandbox-1";
const OFFICIAL_VERSION = "v1.31.6+k3s1";
const OFFICIAL_URL = "https://github.com/k3s-io/k3s/releases/download/v1.31.6%2Bk3s1/k3s";
const OFFICIAL_SHA256 = "9f82f06b4cf318fcf4eeda3f4fedaa10c0cebc418b1a047e72b104f5ea7874c5";
const placement = createPlacement({ id: "unit-cluster", provider: "daytona-k3s" });
const root = "/tmp/openwork-world-k3s/unit-cluster";

function remoteScript(call: ExecCall): string {
  if (call.args[0] !== "exec") return "";
  assert.equal(call.args.length, 4);
  assert.deepEqual(call.args.slice(0, 3), ["exec", SANDBOX, "--"]);
  const wrapped = call.args[3] ?? "";
  const prefix = "bash -lc '";
  assert(wrapped.startsWith(prefix) && wrapped.endsWith("'"), `Unexpected Daytona exec transport: ${wrapped}`);
  return wrapped.slice(prefix.length, -1).replaceAll(`'"'"'`, "'");
}

function createFake(options: FakeOptions = {}): { exec: DaytonaExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    const call = { args: [...args], opts };
    calls.push(call);
    if (args[0] === "create") {
      if (options.failAt === "sandbox-create") return { stdout: "", stderr: "creation failed\n", code: 1 };
      return { stdout: "created\n", stderr: "", code: 0 };
    }
    if (args[0] === "delete") return { stdout: "deleted\n", stderr: "", code: 0 };
    if (args[0] === "preview-url") {
      if (options.failAt === "preview") return { stdout: "", stderr: "preview failed\n", code: 1 };
      return { stdout: "Preview URL: https://30443.preview.example.test/signed?token=unit\n", stderr: "", code: 0 };
    }
    const script = remoteScript(call);
    if (script === "'true'") {
      if (options.failAt === "sandbox-readiness") return { stdout: "", stderr: "not ready\n", code: 1 };
      return { stdout: "", stderr: "", code: 0 };
    }
    if (script === "'id' '-u'") return { stdout: `${options.uid ?? "0"}\n`, stderr: "", code: 0 };
    if (script === "'sudo' '-n' 'true'" && options.sudoFails) {
      return { stdout: "", stderr: "sudo: a password is required\n", code: 1 };
    }
    if (script.includes("'curl' '--fail'")) {
      if (options.failAt === "install") return { stdout: "", stderr: "checksum mismatch\n", code: 1 };
      return { stdout: "", stderr: "", code: 0 };
    }
    if (script.includes("'nohup'") && script.includes("'server'")) {
      if (options.failAt === "start") throw new Error("ambiguous Daytona transport failure");
      return { stdout: "", stderr: "", code: 0 };
    }
    if (script.includes("'--raw=/readyz'") && options.failAt === "readiness") {
      return { stdout: "", stderr: "owned server exited\n", code: 1 };
    }
    if (script.startsWith("'helm' ") && options.helmMissing) {
      return { stdout: "", stderr: "bash: helm: command not found\n", code: 127 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { exec, calls };
}

async function provision(fake: { exec: DaytonaExec }): Promise<DaytonaK3sSandboxOwnership> {
  return provisionDaytonaK3sSandbox({ name: SANDBOX, exec: fake.exec });
}

async function createCluster(fake: { exec: DaytonaExec }): Promise<DaytonaK3sClusterHandle> {
  const ownership = await provision(fake);
  return createDaytonaK3sCluster({ placement, ownership });
}

function scripts(calls: ExecCall[]): string[] {
  return calls.filter((call) => call.args[0] === "exec").map(remoteScript);
}

function deletionCalls(calls: ExecCall[]): ExecCall[] {
  return calls.filter((call) => call.args[0] === "delete");
}

test("provisioning uses a safe private Daytona sandbox and v0.173 one-argument bash transport", async () => {
  const fake = createFake();
  const ownership = await provision(fake);
  assert.deepEqual(fake.calls[0], {
    args: ["create", "--name", SANDBOX, "--snapshot", "daytona-large", "--auto-delete", "0", "--target", "us"],
    opts: { timeoutMs: 300_000 },
  });
  assert.equal(fake.calls[0]?.args.includes("--public"), false);
  assert.deepEqual(fake.calls[1], {
    args: ["exec", SANDBOX, "--", "bash -lc ''\"'\"'true'\"'\"''"],
    opts: { timeoutMs: 60_000 },
  });

  const cluster = await createDaytonaK3sCluster({ placement, ownership });
  await cluster.stop();
  assert.equal(parseDaytonaK3sPreviewUrl("Preview URL: https://preview.example.test/path?token=abc\n"), "https://preview.example.test/path?token=abc");
  assert.equal(parseDaytonaK3sPreviewUrl(`Preview URL: https://preview.example.test/path${",".repeat(10_000)}`), "https://preview.example.test/path");
});

test("provisioning rejects unsafe names and non-allowlisted snapshots before execution", async () => {
  const fake = createFake();
  await assert.rejects(provisionDaytonaK3sSandbox({ name: "unsafe sandbox", exec: fake.exec }), /sandbox name/);
  await assert.rejects(provisionDaytonaK3sSandbox({
    name: SANDBOX,
    // @ts-expect-error Verify the runtime boundary as well as the typed snapshot allowlist.
    snapshot: "moving-snapshot",
    exec: fake.exec,
  }), /not allowlisted/);
  assert.equal(fake.calls.length, 0);
});

test("partial sandbox creation and exec-readiness failures delete the whole sandbox", async () => {
  const failures: readonly ("sandbox-create" | "sandbox-readiness")[] = ["sandbox-create", "sandbox-readiness"];
  for (const failAt of failures) {
    const fake = createFake({ failAt });
    await assert.rejects(provision(fake));
    assert.equal(deletionCalls(fake.calls).length, 1, `expected sandbox deletion after ${failAt}`);
    assert.equal(scripts(fake.calls).some((script) => /\b(?:kill|pkill)\b|\.pid|PID/.test(script)), false);
  }
});

test("a forged ownership receipt is rejected before cluster exec or deletion", async () => {
  const fake = createFake();
  const ownership = await provision(fake);
  const forgedOwnership = structuredClone(ownership);
  const before = fake.calls.length;
  await assert.rejects(
    createDaytonaK3sCluster({ placement, ownership: forgedOwnership }),
    /ownership receipt returned by provisionDaytonaK3sSandbox/,
  );
  assert.equal(fake.calls.length, before);
  assert.equal(deletionCalls(fake.calls).length, 0);

  const cluster = await createDaytonaK3sCluster({ placement, ownership });
  const afterClaim = fake.calls.length;
  await assert.rejects(createDaytonaK3sCluster({ placement, ownership }), /unused ownership receipt/);
  assert.equal(fake.calls.length, afterClaim);
  await cluster.stop();
});

test("root lifecycle downloads only the hardcoded official binary and deletes its sandbox idempotently", async () => {
  const fake = createFake();
  const cluster = await createCluster(fake);
  const observed = scripts(fake.calls);

  assert(observed.includes("'id' '-u'"));
  const downloads = observed.filter((script) => script.includes("'curl' '--fail'"));
  assert.equal(downloads.length, 1);
  const install = downloads[0] ?? "";
  assert(install.includes(`'curl' '--fail' '--silent' '--show-error' '--location' '${OFFICIAL_URL}' '--output' '${root}/download/k3s'`));
  assert(install.includes(`'printf' '%s\\n' '${OFFICIAL_SHA256}  ${root}/download/k3s' | 'sha256sum' '--check' '--status' '-'`));
  assert(install.includes(`'mv' '-f' '${root}/download/k3s' '${root}/bin/k3s'`));
  assert.doesNotMatch(install, /get\.k3s\.io|systemctl|openrc|rc-service/);

  const start = observed.find((script) => script.includes("'server'")) ?? "";
  assert(start.includes(`'nohup' '${root}/bin/k3s' 'server' '--data-dir' '${root}/data' '--write-kubeconfig' '${root}/kubeconfig.yaml' '--write-kubeconfig-mode' '0600'`));
  assert.doesNotMatch(start, /'--write-kubeconfig-mode' '0644'/);
  assert(start.includes("'--node-name' 'openwork-unit-cluster'"));
  assert(start.includes("'--snapshotter' 'native'"));
  const readiness = observed.find((script) => script.includes("'--raw=/readyz'")) ?? "";
  assert(readiness.includes(`'${root}/bin/k3s' 'kubectl' '--kubeconfig' '${root}/kubeconfig.yaml' 'get' '--raw=/readyz'`));
  assert.doesNotMatch(readiness, /pgrep/);
  assert.equal(cluster.version, OFFICIAL_VERSION);
  assert.deepEqual(cluster.paths, {
    root,
    binary: `${root}/bin/k3s`,
    download: `${root}/download/k3s`,
    dataDir: `${root}/data`,
    kubeconfig: `${root}/kubeconfig.yaml`,
    serverLog: `${root}/server.log`,
  });

  await cluster.stop();
  await cluster.stop();
  await cluster[Symbol.asyncDispose]();
  assert.equal(deletionCalls(fake.calls).length, 1);
  assert.deepEqual(deletionCalls(fake.calls)[0], {
    args: ["delete", SANDBOX],
    opts: { timeoutMs: 60_000, input: "y\n" },
  });
  assert(scripts(fake.calls).every((script) => !/\b(?:kill|pkill)\b|\.pid|PID/.test(script)));
});

test("non-root lifecycle requires passwordless sudo for k3s, kubectl, and Helm kubeconfig access", async () => {
  const fake = createFake({ uid: "1000" });
  const cluster = await createCluster(fake);
  const observed = scripts(fake.calls);

  assert(observed.includes("'id' '-u'"));
  assert(observed.includes("'sudo' '-n' 'true'"));
  assert(observed.some((script) => script.includes(`'nohup' 'sudo' '-n' '${root}/bin/k3s' 'server'`)));
  assert(observed.some((script) => script.includes(`'sudo' '-n' '${root}/bin/k3s' 'kubectl' '--kubeconfig' '${root}/kubeconfig.yaml'`)));
  await cluster.kubectl(["get", "pods"]);
  assert.equal(scripts(fake.calls).at(-1), `'sudo' '-n' '${root}/bin/k3s' 'kubectl' '--kubeconfig' '${root}/kubeconfig.yaml' 'get' 'pods'`);
  await cluster.helm(["list", "--all-namespaces"]);
  assert.equal(scripts(fake.calls).at(-1), `'sudo' '-n' 'helm' '--kubeconfig' '${root}/kubeconfig.yaml' 'list' '--all-namespaces'`);
  await cluster.stop();
});

test("lack of root and passwordless sudo fails before start and deletes the owned sandbox", async () => {
  const fake = createFake({ uid: "1000", sudoFails: true });
  await assert.rejects(createCluster(fake), /passwordless sudo.*failed|password is required/s);
  assert(scripts(fake.calls).every((script) => !script.includes("'server'")));
  assert.equal(deletionCalls(fake.calls).length, 1);
});

test("every install, ambiguous start, and readiness failure deletes the entire owned sandbox", async () => {
  const failures: readonly NonNullable<FakeOptions["failAt"]>[] = ["install", "start", "readiness"];
  for (const failAt of failures) {
    const fake = createFake({ failAt });
    await assert.rejects(createCluster(fake));
    assert.equal(deletionCalls(fake.calls).length, 1, `expected owned sandbox deletion after ${failAt}`);
    assert(scripts(fake.calls).every((script) => !/\b(?:kill|pkill)\b|\.pid|PID/.test(script)));
  }
});

test("Helm uses the root-selected privilege and missing Helm fails without curl-pipe installation", async () => {
  const fake = createFake({ helmMissing: true });
  const cluster = await createCluster(fake);
  const before = fake.calls.length;
  await assert.rejects(
    installK3sHelmRelease(cluster, { release: "demo", namespace: "demo-ns", chart: "oci://registry.example.test/team/chart" }),
    /helm: command not found/,
  );
  assert.equal(
    remoteScript(fake.calls[before] ?? { args: [] }),
    `'helm' '--kubeconfig' '${root}/kubeconfig.yaml' 'upgrade' '--install' 'demo' 'oci://registry.example.test/team/chart' '--namespace' 'demo-ns' '--create-namespace'`,
  );
  assert.equal(fake.calls.slice(before).filter((call) => remoteScript(call).includes("curl")).length, 0);
  await cluster.stop();
});

test("cluster-owned exposure reserves ports, accepts the maximum expiry, and has no independent cleanup", async () => {
  const fake = createFake();
  const cluster = await createCluster(fake);
  const exposure = await exposeK3sService(cluster, {
    namespace: "demo-ns",
    service: "demo-api",
    localPort: 30_443,
    servicePort: 443,
    expiresInSeconds: 86_400,
  });

  assert.equal(exposure.ephemeral, true);
  assert.equal(exposure.persistableInDesktopConfig, false);
  assert.equal(exposure.validUntil, "cluster-disposal-or-expiry");
  assert.equal(exposure.ownedSandboxId, SANDBOX);
  assert.deepEqual(fake.calls.find((call) => call.args[0] === "preview-url")?.args, [
    "preview-url", SANDBOX, "-p", "30443", "--expires", "86400",
  ]);
  const portStart = scripts(fake.calls).find((script) => script.includes("'port-forward'"));
  assert(portStart?.includes(`'${root}/bin/k3s' 'kubectl' '--kubeconfig' '${root}/kubeconfig.yaml' 'port-forward'`));
  const beforeDuplicate = fake.calls.length;
  await assert.rejects(exposeK3sService(cluster, {
    namespace: "other",
    service: "other-api",
    localPort: 30_443,
    servicePort: 80,
    expiresInSeconds: 60,
  }), /already reserved/);
  assert.equal(fake.calls.length, beforeDuplicate);
  await assert.rejects(exposeK3sService(cluster, {
    namespace: "other",
    service: "other-api",
    localPort: 30_444,
    servicePort: 80,
    expiresInSeconds: 86_401,
  }), /between 1 and 86400/);
  assert.equal(fake.calls.length, beforeDuplicate);
  assert.equal(deletionCalls(fake.calls).length, 0);
  await cluster.stop();
  assert.equal(deletionCalls(fake.calls).length, 1);
  assert(scripts(fake.calls).every((script) => !/\b(?:kill|pkill)\b|\.pid|PID/.test(script)));
});

test("an ambiguous exposure failure deletes the cluster sandbox instead of process cleanup", async () => {
  const fake = createFake({ failAt: "preview" });
  const cluster = await createCluster(fake);
  await assert.rejects(exposeK3sService(cluster, {
    namespace: "demo",
    service: "demo-api",
    localPort: 8080,
    servicePort: 80,
    expiresInSeconds: 300,
  }), /preview failed/);
  assert.equal(deletionCalls(fake.calls).length, 1);
  assert(scripts(fake.calls).every((script) => !/\b(?:kill|pkill)\b|\.pid|PID/.test(script)));
});

test("malformed placement, version, Helm, and exposure inputs fail before cluster execution", async () => {
  const fake = createFake();
  const ownership = await provision(fake);
  const local = createPlacement({ id: "local-unit", provider: "local" });
  const missingCapability: Placement = { ...placement, capabilities: ["command:bash", "port:daytona-preview"] };
  const before = fake.calls.length;
  await assert.rejects(createDaytonaK3sCluster({ placement: local, ownership }), /requires placement provider/);
  await assert.rejects(createDaytonaK3sCluster({ placement: missingCapability, ownership }), /missing capability/);
  await assert.rejects(createDaytonaK3sCluster({
    placement,
    ownership,
    // @ts-expect-error Verify the runtime boundary as well as the typed version allowlist.
    version: "v1.99.0+k3s1",
  }), /not supported/);
  assert.equal(fake.calls.length, before);

  const cluster = await createDaytonaK3sCluster({ placement, ownership });
  const beforeInvalidTools = fake.calls.length;
  assert.throws(() => installK3sHelmRelease(cluster, { release: "Bad Release", namespace: "demo", chart: "repo/chart" }), /Helm release/);
  assert.throws(() => installK3sHelmRelease(cluster, { release: "demo", namespace: "Bad_Namespace", chart: "repo/chart" }), /Helm namespace/);
  assert.throws(() => installK3sHelmRelease(cluster, { release: "demo", namespace: "demo", chart: "--set" }), /Helm chart/);
  await assert.rejects(exposeK3sService(cluster, {
    namespace: "demo",
    service: "Bad_Service",
    localPort: 8080,
    servicePort: 80,
    expiresInSeconds: 300,
  }), /Kubernetes service/);
  await assert.rejects(exposeK3sService(cluster, {
    namespace: "demo",
    service: "demo-api",
    localPort: 0,
    servicePort: 80,
    expiresInSeconds: 300,
  }), /local port/);
  await assert.rejects(exposeK3sService(cluster, {
    namespace: "demo",
    service: "demo-api",
    localPort: 8080,
    servicePort: 70_000,
    expiresInSeconds: 300,
  }), /service port/);
  await assert.rejects(cluster.kubectl(["get\npods"]), /control characters/);
  assert.equal(fake.calls.length, beforeInvalidTools);
  await cluster.stop();
});
