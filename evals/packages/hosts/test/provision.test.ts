import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  DESKTOP_RELEASE_ARCHIVE_INSTALLER,
  deleteSandboxes,
  desktopSandboxName,
  encodeDenExtraEnv,
  parseConnectorE2eTestEnv,
  prepareSandboxRepo,
  provisionDesktopSandbox,
  publishedDesktopReleaseInstallCommand,
  resolvePublishedDesktopRelease,
  renderConnectorE2eTestEnv,
  serverSandboxName,
  startFaultProxyOnSandbox,
  startMockOnSandbox,
} from "../src/provision.ts";
import type { ConnectorE2eTestEnv } from "../src/provision.ts";
import type { DaytonaExec } from "../src/daytona.ts";

const execFileAsync = promisify(execFile);

interface ExecCall {
  args: string[];
  opts?: { input?: string; timeoutMs?: number };
}

const SOURCE_SHA = "a".repeat(40);
const DEPENDENCY_FINGERPRINT = "b".repeat(64);

function desktopFake(diskUse = "40%"):
  { exec: DaytonaExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    if (args[0] === "sandbox" && args[1] === "start") {
      return { stdout: "", stderr: "already started", code: 1 };
    }
    if (args[0] === "snapshot") {
      return { stdout: JSON.stringify([{ name: "openwork-eval-vnc", id: "snapshot-123" }]), stderr: "", code: 0 };
    }
    if (args[0] !== "exec") return { stdout: "", stderr: "", code: 0 };

    const script = args[3] ?? "";
    if (script.includes("git status") || script.includes("git fetch")) {
      return { stdout: `${SOURCE_SHA}\n`, stderr: "", code: 0 };
    }
    if (script.includes("git ls-tree")) return { stdout: `${DEPENDENCY_FINGERPRINT}\n`, stderr: "", code: 0 };
    if (script.includes("SOURCE_PREPARED")) return { stdout: "SOURCE_STALE\n", stderr: "", code: 0 };
    if (script.includes("df -P")) {
      return { stdout: `/dev/root 100 40 60 ${diskUse} /workspace\n`, stderr: "", code: 0 };
    }
    if (script.includes("du -sh")) return { stdout: "8G /workspace/node_modules\n", stderr: "", code: 0 };
    if (script.includes("pgrep -f Xvfb")) return { stdout: "XVFB_OK\n", stderr: "", code: 0 };
    if (script.includes("xdg-open-proof")) return { stdout: "XDG_OPEN_WORKS\n", stderr: "", code: 0 };
    if (script.includes("json/version")) return { stdout: '{"Browser":"Chrome/144"}', stderr: "", code: 0 };
    if (script.includes("%{http_code}")) return { stdout: "200", stderr: "", code: 0 };
    if (script.includes("install.py")) {
      return { stdout: "OPENWORK_RELEASE_BINARY=/workspace/.openwork-daytona/releases/enterprise-0.18.44/app/openwork-enterprise\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { exec, calls };
}

function assertRemoteCommandsAreSingleArgument(calls: ExecCall[]): void {
  for (const call of calls.filter((entry) => entry.args[0] === "exec")) {
    assert.equal(call.args.length, 4);
    assert(call.args[3]?.startsWith("bash -lc '"));
  }
}

test("connector E2E test env rendering and parsing round-trip the provision contract", () => {
  const facts: ConnectorE2eTestEnv = {
    denApiUrl: "https://den-api.example.test",
    denWebUrl: "https://den-web.example.test",
    sandboxA: "desktop-a",
    sandboxB: "desktop-b",
    mockUrl: "https://mock.example.test",
    ref: "feat/eval-connector-two-members",
    created: ["den", "desktop-a"],
  };
  const content = renderConnectorE2eTestEnv(facts);

  assert.deepEqual(parseConnectorE2eTestEnv(content), facts);
  assert.match(content, /^# provisioned for org-connector-two-members — generated .*; ref=feat\/eval-connector-two-members$/m);
  assert.match(content, /^# provision-created=den,desktop-a$/m);
  assert.match(content, /OPENWORK_EVAL_MODEL=big-pickle/);
  const missingApi = content.split("\n").filter((line) => !line.startsWith("OPENWORK_EVAL_DEN_API_URL=")).join("\n");
  assert.throws(() => parseConnectorE2eTestEnv(missingApi), /OPENWORK_EVAL_DEN_API_URL/);
});

test("Den extra env is carried as base64 KEY=VALUE lines and refuses unsafe names", () => {
  const encoded = encodeDenExtraEnv({ DEN_DASHBOARDS_ENABLED: "true", DEN_WORKER_URL_TEMPLATE: "https://w.local/{id}?a=b" });
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
  assert.equal(
    Buffer.from(encoded, "base64").toString("utf8"),
    "DEN_DASHBOARDS_ENABLED=true\nDEN_WORKER_URL_TEMPLATE=https://w.local/{id}?a=b",
  );
  assert.throws(() => encodeDenExtraEnv({ "den-flag": "x" }), /Unsafe Den environment name/);
  assert.throws(() => encodeDenExtraEnv({ "$(id)": "x" }), /Unsafe Den environment name/);
  assert.throws(() => encodeDenExtraEnv({ DEN_X: "a\nb" }), /may not contain a newline/);
});

test("server sandbox names are unique within the same CI process and second", () => {
  const first = serverSandboxName();
  const second = serverSandboxName();

  assert.match(first, new RegExp(`^openwork-server-\\d{8}-\\d{6}-${process.pid}-[0-9a-f]{8}$`));
  assert.notEqual(first, second);
});

test("desktop sandbox names stay unique when parallel workers use the same surface name", () => {
  const first = desktopSandboxName("testkit admin");
  const second = desktopSandboxName("testkit admin");

  assert.match(first, new RegExp(`^openwork-connector-testkit-admin-\\d{8}-\\d{6}-${process.pid}-[0-9a-f]{8}$`));
  assert.notEqual(first, second);
});

test("provisionDesktopSandbox reuses a sandbox and keeps every remote command in one argument", async () => {
  const { exec, calls } = desktopFake();

  const result = await provisionDesktopSandbox({ ref: "dev", name: "a", reuse: "existing-a", exec, log: () => undefined });

  assert.equal(result.sandbox, "existing-a");
  assert.equal(result.created, false);
  assert(result.source);
  assert.equal(result.source.actualSha, SOURCE_SHA);
  assert.equal(result.release, undefined);
  assert.deepEqual(calls[0]?.args, ["sandbox", "start", "existing-a"]);
  assert.equal(calls.filter((call) => call.args[0] === "create").length, 0);
  assert.equal(calls.filter((call) => call.args[0] === "snapshot").length, 0);
  const lastFirstBootCall = calls.findLastIndex((call) => call.args[3]?.includes("/tmp/warmup-profile"));
  assert(lastFirstBootCall >= 0);
  const sourceReceiptCall = calls.findIndex((call) => call.args[3]?.includes("source-receipt.json"));
  assert(sourceReceiptCall >= 0 && sourceReceiptCall < lastFirstBootCall, "source receipt must be verified before any app warmup starts");
  assertRemoteCommandsAreSingleArgument(calls);
});

test("prepareSandboxRepo updates a wrong HEAD and verifies it before caller launch", async () => {
  const oldSha = "c".repeat(40);
  const expectedSha = "d".repeat(40);
  let actualSha = oldSha;
  const events: string[] = [];
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    const script = args[3] ?? "";
    if (script.includes("git status")) {
      events.push("verify");
      return { stdout: `${actualSha}\n`, stderr: "", code: 0 };
    }
    if (script.includes("git fetch")) {
      events.push("resolve");
      return { stdout: `${expectedSha}\n`, stderr: "", code: 0 };
    }
    if (script.includes("git checkout --detach")) {
      events.push("checkout");
      actualSha = expectedSha;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (script.includes("git ls-tree")) {
      events.push("fingerprint");
      return { stdout: `${DEPENDENCY_FINGERPRINT}\n`, stderr: "", code: 0 };
    }
    if (script.includes("SOURCE_PREPARED")) return { stdout: "SOURCE_STALE\n", stderr: "", code: 0 };
    if (script.includes("pnpm install --frozen-lockfile")) {
      events.push("install");
      return { stdout: "", stderr: "", code: 0 };
    }
    if (script.includes("source-receipt.json")) events.push("receipt");
    return { stdout: "", stderr: "", code: 0 };
  };

  const receipt = await prepareSandboxRepo({ sandbox: "prepared-a", ref: expectedSha, exec, log: () => undefined });
  events.push("launch");

  assert.equal(receipt.expectedSha, expectedSha);
  assert.equal(receipt.actualSha, expectedSha);
  assert.equal(receipt.dependenciesInstalled, true);
  assert.deepEqual(events, ["verify", "resolve", "checkout", "verify", "fingerprint", "install", "verify", "receipt", "launch"]);
  const resolveCall = calls.find((call) => call.args[3]?.includes("git fetch"));
  assert(resolveCall?.args[3]?.includes(`${expectedSha}^{commit}`));
  assert(!resolveCall?.args[3]?.includes("FETCH_HEAD"), "an immutable requested SHA must not resolve through stale FETCH_HEAD");
  assert(calls.some((call) => call.args[3]?.includes(`git checkout --detach \"${expectedSha}\"`)));
  assertRemoteCommandsAreSingleArgument(calls);
});

test("prepareSandboxRepo fails closed on dirty source before fetch or checkout", async () => {
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    return { stdout: "", stderr: "Refusing source preparation because /workspace is dirty:\n M package.json\n", code: 42 };
  };

  await assert.rejects(
    prepareSandboxRepo({ sandbox: "dirty-a", ref: SOURCE_SHA, exec, log: () => undefined }),
    /workspace is dirty/,
  );
  assert.equal(calls.length, 1);
  assert(!calls[0]?.args[3]?.includes("git fetch"));
});

test("prepareSandboxRepo skips checkout and install when source is already prepared", async () => {
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    const script = args[3] ?? "";
    if (script.includes("git status") || script.includes("git fetch")) {
      return { stdout: `${SOURCE_SHA}\n`, stderr: "", code: 0 };
    }
    if (script.includes("git ls-tree")) return { stdout: `${DEPENDENCY_FINGERPRINT}\n`, stderr: "", code: 0 };
    if (script.includes("SOURCE_PREPARED")) return { stdout: "SOURCE_PREPARED\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };

  const receipt = await prepareSandboxRepo({ sandbox: "prepared-a", ref: SOURCE_SHA, exec, log: () => undefined });

  assert.equal(receipt.dependenciesInstalled, false);
  assert(!calls.some((call) => call.args[3]?.includes("git checkout --detach")));
  assert(!calls.some((call) => call.args[3]?.includes("pnpm install")));
});

test("prepareSandboxRepo rejects a post-checkout source mismatch before install", async () => {
  const oldSha = "e".repeat(40);
  const expectedSha = "f".repeat(40);
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    const script = args[3] ?? "";
    if (script.includes("git status")) return { stdout: `${oldSha}\n`, stderr: "", code: 0 };
    if (script.includes("git fetch")) return { stdout: `${expectedSha}\n`, stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };

  await assert.rejects(
    prepareSandboxRepo({ sandbox: "mismatch-a", ref: expectedSha, exec, log: () => undefined }),
    new RegExp(`expected ${expectedSha}, received ${oldSha}`),
  );
  assert(calls.some((call) => call.args[3]?.includes("git checkout --detach")));
  assert(!calls.some((call) => call.args[3]?.includes("pnpm install")));
});

test("provisionDesktopSandbox resolves the snapshot id and creates with connector flags", async () => {
  const { exec, calls } = desktopFake();

  const result = await provisionDesktopSandbox({ ref: "dev", name: "b", exec, log: () => undefined });

  assert.equal(result.created, true);
  const create = calls.find((call) => call.args[0] === "create");
  assert(create);
  assert(create.args.includes("snapshot-123"));
  assert(!create.args.includes("--volume"), "eval secrets must not be mounted next to an untrusted ref by default");
  assert.equal(create.args[create.args.indexOf("--auto-stop") + 1], "60");
  assert(create.args.includes("--public"));
  assert.equal(calls.filter((call) => call.args[0] === "sandbox" && call.args[1] === "start").length, 0);
  assertRemoteCommandsAreSingleArgument(calls);
});

test("published desktop provisioning resolves exact GitHub metadata and skips every source build gate", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const assetName = "openwork-enterprise-linux-x64-0.18.44.tar.gz";
  const metadata = {
    tag_name: "v0.18.44",
    draft: false,
    assets: [{
      name: assetName,
      state: "uploaded",
      size: 123,
      digest,
      browser_download_url: `https://github.com/different-ai/openwork/releases/download/v0.18.44/${assetName}`,
    }],
  };
  const releaseFetch: typeof fetch = async () => new Response(JSON.stringify(metadata), { status: 200 });
  const resolved = await resolvePublishedDesktopRelease({ version: "0.18.44", distribution: "enterprise" }, releaseFetch);
  assert.equal(resolved.assetName, assetName);
  assert.equal(resolved.digest, digest);

  const { exec, calls } = desktopFake();
  const result = await provisionDesktopSandbox({
    ref: "this-ref-must-not-be-used",
    name: "release",
    release: { version: "0.18.44", distribution: "enterprise" },
    releaseFetch,
    autoStopMinutes: 0,
    exec,
    log: () => undefined,
  });

  assert.equal(result.release?.digest, digest);
  assert.equal(result.source, undefined);
  assert.equal(result.release?.binaryPath, "/workspace/.openwork-daytona/releases/enterprise-0.18.44/app/openwork-enterprise");
  const create = calls.find((call) => call.args[0] === "create");
  assert(create);
  assert.equal(create.args[create.args.indexOf("--auto-stop") + 1], "0");
  const remote = calls.map((call) => call.args[3] ?? "").join("\n");
  assert.match(remote, /install\.py/);
  assert.match(remote, /openwork-enterprise-linux-x64-0\.18\.44\.tar\.gz/);
  for (const forbidden of ["git fetch", "pnpm install", "warmup-electron", "vite-prewarm", "dev:electron"]) {
    assert(!remote.includes(forbidden), `release provisioning must not run ${forbidden}`);
  }
  assert(!calls.some((call) => call.args.includes("--volume")));
});

test("published desktop install rejects an invalid digest before extracting or returning an executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-release-digest-"));
  const archive = join(root, "source.tar.gz");
  const fakeBin = join(root, "bin");
  const fakeCurl = join(fakeBin, "curl");
  const createArchive = `
import io
import tarfile
import sys
payload = b"#!/bin/sh\\nexit 0\\n"
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    binary = tarfile.TarInfo("openwork-enterprise")
    binary.size = len(payload)
    bundle.addfile(binary, io.BytesIO(payload))
`;
  try {
    await mkdir(fakeBin);
    await execFileAsync("python3", ["-c", createArchive, archive]);
    await writeFile(fakeCurl, `#!/bin/sh
set -eu
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    output=$2
    shift 2
  else
    shift
  fi
done
test -n "$output"
cp "$FAKE_RELEASE_ARCHIVE" "$output"
`);
    await chmod(fakeCurl, 0o755);
    const archiveStat = await stat(archive);
    const install = publishedDesktopReleaseInstallCommand({
      version: "0.18.44",
      distribution: "enterprise",
      assetName: "openwork-enterprise-linux-x64-0.18.44.tar.gz",
      binaryName: "openwork-enterprise",
      browserDownloadUrl: "https://example.test/openwork-enterprise-linux-x64-0.18.44.tar.gz",
      digest: `sha256:${"0".repeat(64)}`,
      size: archiveStat.size,
    }, join(root, "install"));

    await assert.rejects(
      execFileAsync("bash", ["-c", install.command], {
        env: {
          ...process.env,
          FAKE_RELEASE_ARCHIVE: archive,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /Published release SHA-256 mismatch/);
        if ("stdout" in error) assert.doesNotMatch(String(error.stdout), /OPENWORK_RELEASE_BINARY=/);
        return true;
      },
    );
    await assert.rejects(access(install.appRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("published desktop metadata and shared secrets are rejected before sandbox allocation", async () => {
  const { exec, calls } = desktopFake();
  await assert.rejects(
    provisionDesktopSandbox({
      ref: "unused",
      name: "release",
      release: { version: "0.18.44", distribution: "enterprise" },
      secrets: true,
      exec,
      log: () => undefined,
    }),
    /cannot mount the shared eval secrets volume/,
  );
  assert.equal(calls.length, 0);
  const missingFetch: typeof fetch = async () => new Response(JSON.stringify({ tag_name: "v0.18.44", draft: false, assets: [] }), { status: 200 });
  await assert.rejects(
    provisionDesktopSandbox({
      ref: "unused",
      name: "release",
      release: { version: "0.18.44", distribution: "enterprise" },
      releaseFetch: missingFetch,
      exec,
      log: () => undefined,
    }),
    /must contain exactly one/,
  );
  assert.equal(calls.length, 0);
});

test("a failed published release install deletes its partially allocated sandbox", async () => {
  const assetName = "openwork-enterprise-linux-x64-0.18.44.tar.gz";
  const releaseFetch: typeof fetch = async () => new Response(JSON.stringify({
    tag_name: "v0.18.44",
    draft: false,
    assets: [{
      name: assetName,
      state: "uploaded",
      size: 123,
      digest: `sha256:${"a".repeat(64)}`,
      browser_download_url: `https://github.com/different-ai/openwork/releases/download/v0.18.44/${assetName}`,
    }],
  }), { status: 200 });
  const base = desktopFake();
  const exec: DaytonaExec = async (args, options) => {
    if ((args[3] ?? "").includes("install.py")) {
      base.calls.push({ args: [...args], opts: options });
      return { stdout: "", stderr: "checksum mismatch", code: 1 };
    }
    return base.exec(args, options);
  };

  await assert.rejects(
    provisionDesktopSandbox({
      ref: "unused",
      name: "release-failure",
      release: { version: "0.18.44", distribution: "enterprise" },
      releaseFetch,
      exec,
      log: () => undefined,
    }),
    /checksum mismatch/,
  );
  const create = base.calls.find((call) => call.args[0] === "create");
  const remove = base.calls.find((call) => call.args[0] === "delete");
  assert.ok(create);
  assert.deepEqual(remove?.args, ["delete", create.args[2]]);
});

test("published release allocation and readiness failures clean up only newly owned sandboxes", async () => {
  const assetName = "openwork-enterprise-linux-x64-0.18.44.tar.gz";
  const releaseFetch: typeof fetch = async () => new Response(JSON.stringify({
    tag_name: "v0.18.44",
    draft: false,
    assets: [{
      name: assetName,
      state: "uploaded",
      size: 123,
      digest: `sha256:${"a".repeat(64)}`,
      browser_download_url: `https://github.com/different-ai/openwork/releases/download/v0.18.44/${assetName}`,
    }],
  }), { status: 200 });

  for (const failure of ["create", "ready"]) {
    const calls: ExecCall[] = [];
    const exec: DaytonaExec = async (args, opts) => {
      calls.push({ args: [...args], opts });
      if (args[0] === "snapshot") {
        return { stdout: JSON.stringify([{ name: "openwork-eval-vnc", id: "snapshot-123" }]), stderr: "", code: 0 };
      }
      if (args[0] === "create") {
        return failure === "create"
          ? { stdout: "", stderr: "creation failed", code: 1 }
          : { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "exec") return { stdout: "", stderr: "not ready", code: 1 };
      return { stdout: "", stderr: "", code: 0 };
    };

    await assert.rejects(
      provisionDesktopSandbox({
        ref: "unused",
        name: `release-${failure}`,
        release: { version: "0.18.44", distribution: "enterprise" },
        releaseFetch,
        sandboxReadyTimeoutMs: 0,
        exec,
        log: () => undefined,
      }),
      failure === "create" ? /creation failed/ : /exec-ready gate failed/,
    );
    const create = calls.find((call) => call.args[0] === "create");
    assert(create);
    assert.deepEqual(calls.find((call) => call.args[0] === "delete")?.args, ["delete", create.args[2]]);
  }

  const reusedCalls: ExecCall[] = [];
  const reusedExec: DaytonaExec = async (args, opts) => {
    reusedCalls.push({ args: [...args], opts });
    if (args[0] === "exec") return { stdout: "", stderr: "not ready", code: 1 };
    return { stdout: "", stderr: "", code: 0 };
  };
  await assert.rejects(
    provisionDesktopSandbox({
      ref: "unused",
      name: "release-reused",
      reuse: "caller-owned",
      release: { version: "0.18.44", distribution: "enterprise" },
      releaseFetch,
      sandboxReadyTimeoutMs: 0,
      exec: reusedExec,
      log: () => undefined,
    }),
    /exec-ready gate failed/,
  );
  assert(!reusedCalls.some((call) => call.args[0] === "delete"));
});

test("published desktop archive installer rejects traversal and escaping links", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-release-archive-"));
  const archive = join(root, "malicious.tar.gz");
  const extract = join(root, "extract");
  const createArchive = `
import io
import tarfile
import sys
with tarfile.open(sys.argv[1], "w:gz") as bundle:
    traversal = tarfile.TarInfo("../escaped")
    traversal.size = 1
    bundle.addfile(traversal, io.BytesIO(b"x"))
    link = tarfile.TarInfo("openwork-enterprise")
    link.type = tarfile.SYMTYPE
    link.linkname = "../../outside"
    bundle.addfile(link)
`;
  try {
    await execFileAsync("python3", ["-c", createArchive, archive]);
    const archiveBytes = await readFile(archive);
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    await assert.rejects(
      execFileAsync("python3", ["-c", DESKTOP_RELEASE_ARCHIVE_INSTALLER, archive, extract, "openwork-enterprise", digest, String(archiveBytes.byteLength)]),
      (error: unknown) => {
        assert(error instanceof Error);
        assert("stderr" in error);
        assert.match(String(error.stderr), /Archive member escapes extraction root/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rendered values are shell-quoted, because the env file is meant to be sourced", () => {
  const nasty = "$(touch /tmp/pwned); echo it's-here";
  const content = renderConnectorE2eTestEnv({
    denApiUrl: "https://a",
    denWebUrl: "https://w",
    sandboxA: nasty,
    sandboxB: "b",
    mockUrl: "https://m",
    ref: "dev",
    created: [],
  });

  assert(content.includes(`OPENWORK_EVAL_DAYTONA_SANDBOX_A='$(touch /tmp/pwned); echo it'"'"'s-here'`));
  assert.equal(parseConnectorE2eTestEnv(content).sandboxA, nasty);
});

test("an unsafe ref is refused before it can reach a remote shell or a sourced file", async () => {
  const { exec, calls } = desktopFake();

  for (const ref of ["dev\"; rm -rf /; #", "$(curl attacker)", "dev\nrm -rf /", "--upload-pack=evil"]) {
    await assert.rejects(
      provisionDesktopSandbox({ ref, name: "a", reuse: "existing-a", exec, log: () => undefined }),
      /Unsafe git ref/,
    );
    assert.throws(() => renderConnectorE2eTestEnv({
      denApiUrl: "https://a",
      denWebUrl: "https://w",
      sandboxA: "a",
      sandboxB: "b",
      mockUrl: "https://m",
      ref,
      created: [],
    }), /Unsafe git ref/);
  }
  assert.equal(calls.length, 0, "an unsafe ref must be refused before any daytona call");
});

test("the eval secrets volume is mounted only when explicitly asked for", async () => {
  const { exec, calls } = desktopFake();

  await provisionDesktopSandbox({ ref: "dev", name: "b", secrets: true, exec, log: () => undefined });

  const create = calls.find((call) => call.args[0] === "create");
  assert(create?.args.includes("openwork-eval-secrets:/daytona-secrets"));
});

test("provisionDesktopSandbox fails the disk gate above 85 percent", async () => {
  const { exec } = desktopFake("92%");

  await assert.rejects(
    provisionDesktopSandbox({ ref: "dev", name: "a", reuse: "full-a", exec, log: () => undefined }),
    /92%/,
  );
});

test("startMockOnSandbox rejects a health response with the wrong issuer", async () => {
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    if (args[0] === "preview-url") {
      return { stdout: "Preview URL: https://mock.example.test\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ ok: true, issuer: "https://wrong-issuer.example.test" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  await assert.rejects(
    startMockOnSandbox({ sandbox: "den-1", exec, fetchImpl, log: () => undefined }),
    /https:\/\/wrong-issuer\.example\.test.*https:\/\/mock\.example\.test/,
  );
  assertRemoteCommandsAreSingleArgument(calls);
});

test("Daytona preview URL lookup retries a transient control-plane failure", async () => {
  let previewAttempts = 0;
  const exec: DaytonaExec = async (args) => {
    if (args[0] === "preview-url") {
      previewAttempts += 1;
      return previewAttempts === 1
        ? { stdout: "", stderr: "unexpected EOF", code: 1 }
        : { stdout: "Preview URL: https://mock.example.test\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ ok: true, issuer: "https://mock.example.test" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  await startMockOnSandbox({ sandbox: "den-1", exec, fetchImpl, log: () => undefined });

  assert.equal(previewAttempts, 2);
});

test("startFaultProxyOnSandbox uploads and detaches the proxy after resolving its preview URL", async () => {
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    if (args[0] === "preview-url") {
      return { stdout: "Preview URL: https://fault.example.test\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ ok: true, issuer: "https://fault.example.test" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  const proxy = await startFaultProxyOnSandbox({ sandbox: "den-1", exec, fetchImpl, log: () => undefined });

  assert.equal(proxy.url, "https://fault.example.test");
  assert.match(proxy.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(calls[0]?.args, ["preview-url", "den-1", "-p", "3985", "--expires", "86400"]);
  const scripts = calls.filter((call) => call.args[0] === "exec").map((call) => call.args[3]?.slice(10, -1) ?? "");
  assert.match(scripts[0] ?? "", /pkill -f openwork-fault-proxy/);
  assert.match(scripts[1] ?? "", /^printf %s [A-Za-z0-9+/=]+ \| base64 -d > \/tmp\/openwork-fault-proxy\.mjs$/);
  assert(!scripts[1]?.includes("'"));
  assert.match(scripts[2] ?? "", /start_new_session=True/);
  assert.match(scripts[2] ?? "", /UPSTREAM=http:\/\/127\.0\.0\.1:3005/);
  assert.match(scripts[2] ?? "", /node \/tmp\/openwork-fault-proxy\.mjs/);
  assertRemoteCommandsAreSingleArgument(calls);

  await proxy.stop();
  assert.match(calls.at(-1)?.args[3] ?? "", /pkill -f openwork-fault-proxy\.mjs/);
});

test("startFaultProxyOnSandbox rejects a health response with the wrong issuer", async () => {
  const exec: DaytonaExec = async (args) => {
    if (args[0] === "preview-url") {
      return { stdout: "Preview URL: https://fault.example.test\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ ok: true, issuer: "https://wrong-issuer.example.test" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  await assert.rejects(
    startFaultProxyOnSandbox({ sandbox: "den-1", exec, fetchImpl, log: () => undefined }),
    /https:\/\/wrong-issuer\.example\.test.*https:\/\/fault\.example\.test/,
  );
});

test("deleteSandboxes answers the confirmation prompt and tolerates a missing sandbox", async () => {
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    if (args[1] === "gone-2") return { stdout: "", stderr: "sandbox not found", code: 1 };
    return { stdout: "deleted\n", stderr: "", code: 0 };
  };

  await deleteSandboxes(["sandbox-1", "gone-2"], { exec, log: () => undefined });

  assert.deepEqual(calls.map((call) => call.args), [
    ["delete", "sandbox-1"],
    ["delete", "gone-2"],
  ]);
  assert.equal(calls[0]?.opts?.input, "y\n");
});
