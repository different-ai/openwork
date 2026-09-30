import assert from "node:assert/strict";
import test from "node:test";
import { provisionWindowsReleaseSandbox, windowsPowerShellArgs } from "../src/windows-release.ts";
import type { DaytonaExec } from "../src/daytona.ts";
import type { DesktopRelease } from "../src/types.ts";

const DIGEST = "a".repeat(64);
const NAME = "openwork-enterprise-win-x64-0.18.52.exe";
const URL = `https://github.com/different-ai/openwork/releases/download/v0.18.52/${NAME}`;
const VM = "45baa63f-6027-4b23-a17d-206a5c59f247";
const RELEASE: DesktopRelease = { version: "0.18.52", distribution: "enterprise" };
const metadata = { tag_name: "v0.18.52", draft: false, prerelease: false,
  assets: [{ name: NAME, state: "uploaded", digest: `sha256:${DIGEST}`, size: 1234, browser_download_url: URL }] };

function fake() {
  const calls: string[][] = [];
  const scripts: string[] = [];
  let name = "";
  const exec: DaytonaExec = async (args) => {
    calls.push(args);
    if (args[0] === "create") {
      name = args[args.indexOf("--name") + 1] ?? "";
      return { stdout: "created", stderr: "", code: 0 };
    }
    if (args[0] === "info") return { stdout: JSON.stringify({ id: VM, name, public: false, snapshot: "windows-medium", toolboxProxyUrl: "https://daytonaproxy01.net/toolbox" }), stderr: "", code: 0 };
    if (args[0] === "preview-url") return { stdout: `https://${args[args.indexOf("-p") + 1]}-opaque.daytonaproxy01.net`, stderr: "", code: 0 };
    if (args[0] === "exec") {
      const command = args[3] ?? "";
      const script = Buffer.from(command.split("-EncodedCommand ")[1] ?? "", "base64").toString("utf16le");
      scripts.push(script);
      const output = script.includes("WINDOWS_RELEASE_VERIFIED") ? "WINDOWS_RELEASE_VERIFIED"
        : script.includes("Write-Output 'INSTALLED'") ? "INSTALLED"
          : script.includes("GUI_SESSION_1") ? "GUI_SESSION_1"
            : script.includes("/json/version") ? "OpenWork/0.18.52"
              : "EXEC_READY";
      return { stdout: output, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { exec, calls, scripts };
}

test("Windows commands remain one encoded argument with Unicode and quotes intact", () => {
  const script = "Write-Output 'Ä' | Out-String";
  const args = windowsPowerShellArgs(VM, script);
  assert.deepEqual(args.slice(0, 3), ["exec", VM, "--"]);
  assert.equal(Buffer.from((args[3] ?? "").split("-EncodedCommand ")[1] ?? "", "base64").toString("utf16le"), script);
  assert.throws(() => windowsPowerShellArgs("../other", script), /Invalid Windows sandbox/);
});

test("Windows release provisions private VM, verifies asset, launches as interactive user and cleans up", async () => {
  const { exec, calls, scripts } = fake();
  let tracked: string | undefined;
  const steps: string[] = [];
  const desktop = await provisionWindowsReleaseSandbox({
    release: RELEASE, lifetimeMinutes: 120, exec,
    step: (id) => ({ ok: () => { steps.push(`${id}:ok`); }, fail: () => { steps.push(`${id}:fail`); } }),
    releaseFetch: async () => Response.json(metadata),
    request: async (input) => new Response(String(input).includes("vnc.html") ? "noVNC" : "OpenWork/0.18.52"),
    onCreated: async (id, name) => { tracked = `${id}/${name}`; },
    log: () => {},
  });
  assert.equal(desktop.sandbox, VM);
  assert.deepEqual(steps, ["win-release", "win-create", "win-download", "win-install", "win-launch", "win-viewer", "win-cdp"].map((id) => `${id}:ok`));
  assert.match(tracked ?? "", /^45baa63f-.*\/openwork-world-win-[0-9a-f]{16}$/);
  assert.equal(desktop.startup.state, "cdp-responsive");
  assert.equal(desktop.release.assetName, NAME);
  assert.equal(desktop.release.digest, `sha256:${DIGEST}`);
  assert.match(desktop.viewerUrl, /\/vnc.html\?autoconnect=1/);
  assert.match(desktop.cdpUrl ?? "", /^https:\/\/9223-/);
  assert.deepEqual(calls.find((args) => args[0] === "create")?.slice(0, 5), ["create", "--name", tracked?.split("/")[1], "--snapshot", "windows-medium"]);
  assert.equal(calls.some((args) => args.includes("--public") || args.includes("--volume")), false);
  assert.equal(calls.find((args) => args[0] === "create")?.includes("--ttl"), true);
  assert.ok(scripts.some((script) => script.includes("Get-FileHash") && script.includes(DIGEST) && script.includes(NAME)));
  assert.ok(scripts.some((script) => script.includes("/ru Administrator /it") && script.includes("OpenWorkWorldInstall")));
  assert.ok(scripts.some((script) => script.includes("/ru Administrator /it") && script.includes("OpenWorkWorldLaunch")));
  assert.ok(scripts.some((script) => script.includes("SessionId -eq 1")));
  await desktop[Symbol.asyncDispose]();
  assert.deepEqual(calls.at(-1), ["delete", VM]);
});

test("unpublished releases fail before any VM is created", async () => {
  const { exec, calls } = fake();
  await assert.rejects(provisionWindowsReleaseSandbox({ release: RELEASE, lifetimeMinutes: 120, exec,
    releaseFetch: async () => Response.json({ ...metadata, draft: true }) }), /invalid or unpublished metadata/);
  assert.equal(calls.length, 0);
});

test("a failed in-VM installer verification deletes only the freshly created VM", async () => {
  const { exec, calls } = fake();
  const broken: DaytonaExec = async (args) => {
    if (args[0] === "exec" && Buffer.from((args[3] ?? "").split("-EncodedCommand ")[1] ?? "", "base64").toString("utf16le").includes("WINDOWS_RELEASE_VERIFIED")) {
      return { stdout: "", stderr: "published digest mismatch", code: 1 };
    }
    return exec(args);
  };
  await assert.rejects(provisionWindowsReleaseSandbox({ release: RELEASE, lifetimeMinutes: 120, exec: broken,
    releaseFetch: async () => Response.json(metadata), log: () => {} }), /published Windows release digest/);
  assert.deepEqual(calls.at(-1), ["delete", VM]);
});
