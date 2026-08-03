import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteSandboxes,
  parseConnectorSpecEnv,
  provisionDesktopSandbox,
  renderConnectorSpecEnv,
  startMockOnSandbox,
} from "../src/provision.ts";
import type { ConnectorSpecEnv } from "../src/provision.ts";
import type { DaytonaExec } from "../src/daytona.ts";

interface ExecCall {
  args: string[];
  opts?: { input?: string; timeoutMs?: number };
}

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
    if (script.includes("git rev-parse")) return { stdout: "abc1234\n", stderr: "", code: 0 };
    if (script.includes("df -P")) {
      return { stdout: `/dev/root 100 40 60 ${diskUse} /workspace\n`, stderr: "", code: 0 };
    }
    if (script.includes("du -sh")) return { stdout: "8G /workspace/node_modules\n", stderr: "", code: 0 };
    if (script.includes("pgrep -f Xvfb")) return { stdout: "XVFB_OK\n", stderr: "", code: 0 };
    if (script.includes("xdg-open-proof")) return { stdout: "XDG_OPEN_WORKS\n", stderr: "", code: 0 };
    if (script.includes("json/version")) return { stdout: '{"Browser":"Chrome/144"}', stderr: "", code: 0 };
    if (script.includes("%{http_code}")) return { stdout: "200", stderr: "", code: 0 };
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

test("renderConnectorSpecEnv and parseConnectorSpecEnv round-trip the connector spec contract", () => {
  const facts: ConnectorSpecEnv = {
    denApiUrl: "https://den-api.example.test",
    denWebUrl: "https://den-web.example.test",
    sandboxA: "desktop-a",
    sandboxB: "desktop-b",
    mockUrl: "https://mock.example.test",
    ref: "feat/eval-connector-two-members",
    created: ["den", "desktop-a"],
  };
  const content = renderConnectorSpecEnv(facts);

  assert.deepEqual(parseConnectorSpecEnv(content), facts);
  assert.match(content, /^# provisioned for org-connector-two-members — generated .*; ref=feat\/eval-connector-two-members$/m);
  assert.match(content, /^# provision-created=den,desktop-a$/m);
  assert.match(content, /OPENWORK_EVAL_MODEL=big-pickle/);
  const missingApi = content.split("\n").filter((line) => !line.startsWith("OPENWORK_EVAL_DEN_API_URL=")).join("\n");
  assert.throws(() => parseConnectorSpecEnv(missingApi), /OPENWORK_EVAL_DEN_API_URL/);
});

test("provisionDesktopSandbox reuses a sandbox and keeps every remote command in one argument", async () => {
  const { exec, calls } = desktopFake();

  const result = await provisionDesktopSandbox({ ref: "dev", name: "a", reuse: "existing-a", exec, log: () => undefined });

  assert.deepEqual(result, { sandbox: "existing-a", created: false });
  assert.deepEqual(calls[0]?.args, ["sandbox", "start", "existing-a"]);
  assert.equal(calls.filter((call) => call.args[0] === "create").length, 0);
  assert.equal(calls.filter((call) => call.args[0] === "snapshot").length, 0);
  assertRemoteCommandsAreSingleArgument(calls);
});

test("provisionDesktopSandbox resolves the snapshot id and creates with connector flags", async () => {
  const { exec, calls } = desktopFake();

  const result = await provisionDesktopSandbox({ ref: "dev", name: "b", exec, log: () => undefined });

  assert.equal(result.created, true);
  const create = calls.find((call) => call.args[0] === "create");
  assert(create);
  assert(create.args.includes("snapshot-123"));
  assert(!create.args.includes("--volume"), "eval secrets must not be mounted next to an untrusted ref by default");
  assert(create.args.includes("--auto-stop"));
  assert(create.args.includes("--public"));
  assert.equal(calls.filter((call) => call.args[0] === "sandbox" && call.args[1] === "start").length, 0);
  assertRemoteCommandsAreSingleArgument(calls);
});

test("rendered values are shell-quoted, because the env file is meant to be sourced", () => {
  const nasty = "$(touch /tmp/pwned); echo it's-here";
  const content = renderConnectorSpecEnv({
    denApiUrl: "https://a",
    denWebUrl: "https://w",
    sandboxA: nasty,
    sandboxB: "b",
    mockUrl: "https://m",
    ref: "dev",
    created: [],
  });

  assert(content.includes(`OPENWORK_EVAL_DAYTONA_SANDBOX_A='$(touch /tmp/pwned); echo it'"'"'s-here'`));
  assert.equal(parseConnectorSpecEnv(content).sandboxA, nasty);
});

test("an unsafe ref is refused before it can reach a remote shell or a sourced file", async () => {
  const { exec, calls } = desktopFake();

  for (const ref of ["dev\"; rm -rf /; #", "$(curl attacker)", "dev\nrm -rf /", "--upload-pack=evil"]) {
    await assert.rejects(
      provisionDesktopSandbox({ ref, name: "a", reuse: "existing-a", exec, log: () => undefined }),
      /Unsafe git ref/,
    );
    assert.throws(() => renderConnectorSpecEnv({
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
