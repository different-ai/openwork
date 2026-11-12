import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createGithubReleaseClient } from "./github-release.mjs";
import { isTransientNetworkFailure, runNetworkCommand } from "./network-retry.mjs";
import { publishAlphaAssets } from "./publish-alpha-assets.mjs";

const ok = (value = "") => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const fail = (stderr) => ({ status: 1, stdout: "", stderr });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "openwork-network-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}
function client(responses) {
  const calls = [];
  const delays = [];
  return {
    calls, delays,
    github: createGithubReleaseClient({
      spawn(command, args) {
        calls.push({ command, args });
        assert.ok(responses.length > 0, `Unexpected gh call: ${args.join(" ")}`);
        return responses.shift();
      },
      sleep: async delay => { delays.push(delay); },
      log() {},
    }),
  };
}

for (const message of [
  "gh: Service Unavailable (HTTP 503)", "gh: HTTP 429", "gh: HTTP 502", "read: connection reset by peer",
  "dial tcp: lookup api.github.com: no such host", "net/http: TLS handshake timeout", "unexpected EOF",
  "curl: (28) Operation timed out", "curl: (22) The requested URL returned error: 503", "ECONNRESET", "EAI_AGAIN",
]) {
  test(`classifies transient failure: ${message}`, () => assert.equal(isTransientNetworkFailure(message), true));
}
for (const message of [
  "gh: HTTP 401", "gh: HTTP 403", "gh: HTTP 404", "gh: HTTP 409", "gh: HTTP 422", "gh: HTTP 501",
  "curl: (22) The requested URL returned error: 404", "curl: (60) SSL certificate problem", "curl: (23) Failed writing body",
  "ENOENT", "ENOSPC", "OpenCode v2 archive integrity mismatch", "error TS2322: Type does not match",
  "codesign failed", "unzip: invalid archive", "unknown command", "HTTP 503\nHTTP 401", "ECONNRESET\nEINTEGRITY",
]) {
  test(`does not retry deterministic failure: ${message}`, async () => {
    let attempts = 0;
    const result = await runNetworkCommand("test", [], {}, {
      spawn: () => { attempts++; return fail(message); },
      sleep: () => assert.fail("must not sleep"), log() {},
    });
    assert.equal(result.status, 1);
    assert.equal(attempts, 1);
  });
}

test("network retries stop after three attempts with bounded exponential delay", async () => {
  const { github, calls, delays } = client([fail("HTTP 503"), fail("HTTP 503"), fail("HTTP 503")]);
  await assert.rejects(github.command(["api", "test"]), /503/);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [1000, 2000]);
});
test("network retry returns successful stdout", async () => {
  const { github, calls } = client([fail("unexpected EOF"), ok("result")]);
  assert.equal(await github.command(["api", "test"]), "result");
  assert.equal(calls.length, 2);
});
test("spawn and signal failures are not retried", async () => {
  for (const result of [{ error: new Error("ENOENT"), stderr: "HTTP 503" }, { signal: "SIGTERM", stderr: "HTTP 503" }]) {
    let calls = 0;
    await runNetworkCommand("test", [], {}, { spawn: () => { calls++; return result; }, sleep: () => assert.fail(), log() {} });
    assert.equal(calls, 1);
  }
});
test("release absence is only HTTP 404; authorization errors fail closed", async () => {
  assert.equal(await client([fail("gh: Not Found (HTTP 404)")]).github.getRelease("owner/repo", "tag"), null);
  await assert.rejects(client([fail("gh: Forbidden (HTTP 403)")]).github.getRelease("owner/repo", "tag"), /403/);
});
test("uncertain release creation is reconciled before any second create", async () => {
  const { github, calls } = client([fail("unexpected EOF"), ok({ id: 42 })]);
  await github.ensureRelease("owner/repo", "tag", ["--prerelease"]);
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [["release", "create"], ["api", "repos/owner/repo/releases/tags/tag"]]);
});
test("create is retried only after an absent release is confirmed", async () => {
  const { github, calls } = client([fail("HTTP 503"), fail("HTTP 404"), ok()]);
  await github.ensureRelease("owner/repo", "tag", []);
  assert.equal(calls.length, 3);
});
test("prune accepts DELETE response loss followed by 404", async () => {
  const { github, calls } = client([fail("connection reset by peer"), fail("HTTP 404")]);
  await github.deleteAsset("owner/repo", 123);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, calls[1].args);
});
test("asset pagination rejects mixed malformed output", async () => {
  await assert.rejects(client([ok([[{ id: 1 }], { id: 2 }])]).github.listAssets("owner/repo", 1), /pagination/);
});

test("uncertain immutable upload accepts existing identical bytes without reuploading", async t => {
  const file = join(fixture(t), "installer.exe");
  writeFileSync(file, "signed bytes");
  const digest = `sha256:${createHash("sha256").update("signed bytes").digest("hex")}`;
  const { github, calls } = client([fail("unexpected EOF"), ok([[{ name: basename(file), digest }]])]);
  await github.uploadImmutable("owner/repo", "tag", 42, file, "label");
  assert.equal(calls.filter(call => call.args[1] === "upload").length, 1);
  assert.ok(calls.every(call => !call.args.includes("--clobber")));
});
test("uncertain immutable upload fails closed when existing remote bytes differ", async t => {
  const file = join(fixture(t), "installer.exe");
  writeFileSync(file, "signed bytes");
  const { github, calls } = client([fail("HTTP 502"), ok([[{ name: basename(file), digest: "sha256:other" }]])]);
  await assert.rejects(github.uploadImmutable("owner/repo", "tag", 42, file, "label"), /remote bytes differ/);
  assert.equal(calls.filter(call => call.args[1] === "upload").length, 1);
});
test("uncertain immutable upload downloads and hashes when GitHub has no digest", async t => {
  const file = join(fixture(t), "installer.exe");
  writeFileSync(file, "signed bytes");
  const calls = [];
  let staging;
  const github = createGithubReleaseClient({
    spawn(command, args) {
      calls.push(args);
      if (args[1] === "upload") return fail("unexpected EOF");
      if (args[1] === "--paginate") return ok([[{ name: basename(file), digest: null }]]);
      assert.equal(args[1], "download");
      staging = args[args.indexOf("--dir") + 1];
      writeFileSync(join(staging, basename(file)), "signed bytes");
      return ok();
    },
    sleep: async () => {}, log() {},
  });
  await github.uploadImmutable("owner/repo", "tag", 42, file, "label");
  assert.equal(calls.filter(args => args[1] === "upload").length, 1);
  assert.throws(() => readFileSync(join(staging, basename(file))), /ENOENT/);
});
test("uncertain immutable upload fails closed if reconciliation cannot read assets", async t => {
  const file = join(fixture(t), "installer.exe");
  writeFileSync(file, "signed bytes");
  const { github, calls } = client([fail("HTTP 503"), fail("HTTP 403")]);
  await assert.rejects(github.uploadImmutable("owner/repo", "tag", 42, file, "label"), /403/);
  assert.equal(calls.filter(call => call.args[1] === "upload").length, 1);
});
test("immutable upload retries are bounded even when the remote asset stays absent", async t => {
  const file = join(fixture(t), "installer.exe");
  writeFileSync(file, "signed bytes");
  const { github, calls, delays } = client(Array.from({ length: 3 }, () => [fail("HTTP 503"), ok([[]])]).flat());
  await assert.rejects(github.uploadImmutable("owner/repo", "tag", 42, file, "label"), /503/);
  assert.equal(calls.filter(call => call.args[1] === "upload").length, 3);
  assert.deepEqual(delays, [1000, 2000]);
});
test("uncertain immutable upload retries only after absence is confirmed", async t => {
  const file = join(fixture(t), "installer.exe");
  writeFileSync(file, "signed bytes");
  const { github, calls } = client([fail("HTTP 503"), ok([[]]), ok()]);
  await github.uploadImmutable("owner/repo", "tag", 42, file, "label");
  assert.deepEqual(calls.map(call => call.args[1]), ["upload", "--paginate", "upload"]);
});
test("immutable upload collision is not treated as transient", async t => {
  const file = join(fixture(t), "installer.exe");
  writeFileSync(file, "signed bytes");
  const { github, calls } = client([fail("gh: already_exists (HTTP 422)")]);
  await assert.rejects(github.uploadImmutable("owner/repo", "tag", 42, file, "label"), /422/);
  assert.equal(calls.length, 1);
});

function alphaFixture(t, platform = "windows") {
  const dist = fixture(t);
  const version = "1.2.3-alpha.100.1";
  const installer = platform === "windows" ? `openwork-win-x64-${version}.exe` : `openwork-mac-arm64-${version}.zip`;
  const manifest = platform === "windows" ? "latest.yml" : "latest-mac.yml";
  for (const name of [installer, `${installer}.blockmap`, manifest]) writeFileSync(join(dist, name), "bytes");
  const calls = [];
  const github = {
    getRelease: async () => ({ id: 42 }),
    listAssets: async () => [],
    ensureRelease: async () => { calls.push("create"); },
    uploadImmutable: async (...args) => { calls.push(basename(args[3])); },
    command: async args => { calls.push(basename(args[3].split("#")[0])); },
  };
  const env = {
    GITHUB_REPOSITORY: "owner/repo", CHANNEL_TAG: platform === "windows" ? "alpha-windows-test" : "alpha-macos-test",
    ALPHA_VERSION: version, ALPHA_COMMIT: "abcdef0", ALPHA_BUILD_STARTED_AT: "2026-01-01T00:00:00Z",
    GITHUB_SHA: "abcdef0", ALPHA_RELEASE_NAME: "Alpha", GITHUB_OUTPUT: join(dist, "output"),
  };
  return { platform, dist, env, github, calls, manifest, installer };
}
for (const platform of ["windows", "mac"]) {
  test(`${platform} alpha publishes manifest last and records success only afterward`, async t => {
    const input = alphaFixture(t, platform);
    assert.equal(await publishAlphaAssets(input), true);
    assert.equal(input.calls.at(-1), input.manifest);
    assert.equal(input.calls.length, 3);
    assert.equal(readFileSync(input.env.GITHUB_OUTPUT, "utf8"), "published=true\n");
  });
}
test("alpha publication skips equal Windows version without touching the manifest", async t => {
  const input = alphaFixture(t);
  input.github.listAssets = async () => [{ name: input.installer }];
  assert.equal(await publishAlphaAssets(input), false);
  assert.deepEqual(input.calls, []);
});
test("failed artifact upload does not publish the manifest or success output", async t => {
  const input = alphaFixture(t);
  input.github.uploadImmutable = async () => { throw new Error("HTTP 403"); };
  await assert.rejects(publishAlphaAssets(input), /403/);
  assert.deepEqual(input.calls, []);
  assert.throws(() => readFileSync(input.env.GITHUB_OUTPUT), /ENOENT/);
});
test("missing local artifact and invalid tag fail before remote calls", async t => {
  for (const invalid of ["missing", "tag"]) {
    const input = alphaFixture(t);
    input.github.getRelease = async () => assert.fail("must validate before API calls");
    if (invalid === "missing") rmSync(join(input.dist, input.manifest));
    else input.env.CHANNEL_TAG = "v1.2.3";
    await assert.rejects(publishAlphaAssets(input));
  }
});
