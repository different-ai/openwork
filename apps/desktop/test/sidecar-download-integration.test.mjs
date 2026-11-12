import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { downloadWithRetry } from "../scripts/download-with-retry.mjs";
import { prepareOpencodeV2 } from "../scripts/prepare-opencode-v2.mjs";
import artifacts from "../../server/src/opencode-v2-artifacts.json" with { type: "json" };

const v1 = readFileSync(new URL("../scripts/prepare-sidecar.mjs", import.meta.url), "utf8");
// Exercise the actual top-level download/extraction block without running the
// remainder of prepare-sidecar (which stages and signs real repository files).
const blockStart = v1.indexOf("  await downloadWithRetry(opencodeUrl, archivePath);");
const blockEnd = v1.indexOf("\n  const extractedBinary =", blockStart);
assert.ok(blockStart !== -1 && blockEnd > blockStart);
const extractionBlock = v1.slice(blockStart, blockEnd);

for (const platform of ["darwin", "win32"]) {
  test(`v1 ${platform}: transient download recovery does not replay extraction`, async () => {
    let downloads = 0;
    const extractions = [];
    await runInNewContext(`(async () => { ${extractionBlock} })()`, {
      process: { platform, exit: code => assert.fail(`unexpected exit ${code}`) },
      downloadWithRetry: async (url, output) => {
        await downloadWithRetry(url, output, {
          spawn: () => {
            downloads++;
            return downloads === 1
              ? { status: 22, stderr: "curl: (22) The requested URL returned error: 503" }
              : { status: 0, stderr: "" };
          },
          sleep: async () => {}, log() {},
        });
      },
      opencodeUrl: "https://example.com/sidecar.zip", archivePath: "/staging/archive.zip",
      opencodeAsset: "sidecar.zip", extractDir: "/staging/unpacked", mkdirSync() {},
      spawnSync: (command, args) => { extractions.push({ command, args }); return { status: 0 }; },
    });
    assert.equal(downloads, 2);
    assert.equal(extractions.length, 1);
    assert.equal(extractions[0].command, platform === "win32" ? "powershell" : "unzip");
    assert.ok(!extractions[0].args.join(" ").includes("Invoke-WebRequest"));
  });
  test(`v1 ${platform}: extraction failure is not retried`, async () => {
    let downloads = 0;
    let extractions = 0;
    await assert.rejects(runInNewContext(`(async () => { ${extractionBlock} })()`, {
      process: { platform, exit: code => { throw new Error(`extract exit ${code}`); } },
      downloadWithRetry: async () => { downloads++; },
      opencodeUrl: "https://example.com/sidecar.zip", archivePath: "/staging/archive.zip",
      opencodeAsset: "sidecar.zip", extractDir: "/staging/unpacked", mkdirSync() {},
      spawnSync: () => { extractions++; return { status: 1 }; },
    }), /extract exit 1/);
    assert.equal(downloads, 1);
    assert.equal(extractions, 1);
  });
}
test("v1 deterministic download failure prevents extraction", async () => {
  let downloads = 0;
  await assert.rejects(runInNewContext(`(async () => { ${extractionBlock} })()`, {
    process: { platform: "darwin" },
    downloadWithRetry: async (url, output) => {
      await downloadWithRetry(url, output, {
        spawn: () => { downloads++; return { status: 22, stderr: "curl: (22) The requested URL returned error: 404" }; },
        sleep: () => assert.fail("404 must not retry"), log() {},
      });
    },
    opencodeUrl: "https://example.com/missing.zip", archivePath: "/staging/archive.zip",
    spawnSync: () => assert.fail("must not extract after download failure"),
  }), /404/);
  assert.equal(downloads, 1);
});

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "openwork-sidecar-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("v2 transient download recovery still verifies integrity once and fails closed", async t => {
  const root = directory(t);
  let attempts = 0;
  await assert.rejects(prepareOpencodeV2(root, "aarch64-apple-darwin", {
    download: (url, archive) => downloadWithRetry(url, archive, {
      spawn(command, args) {
        assert.equal(args.at(-1), artifacts.platforms["darwin-arm64"].url);
        attempts++;
        if (attempts === 1) return { status: 28, stderr: "curl: (28) Operation timed out" };
        writeFileSync(archive, "not the pinned archive");
        return { status: 0, stderr: "" };
      },
      sleep: async () => {}, log() {},
    }),
  }), /OpenCode v2 archive integrity mismatch/);
  assert.equal(attempts, 2);
  assert.deepEqual(readdirSync(root), [], "must clean temporary archive and never install an unverified binary/receipt");
});
test("v2 permanent download error is not retried and staging is cleaned", async t => {
  const root = directory(t);
  let attempts = 0;
  await assert.rejects(prepareOpencodeV2(root, "aarch64-apple-darwin", {
    download: (url, archive) => downloadWithRetry(url, archive, {
      spawn: () => { attempts++; return { status: 22, stderr: "curl: (22) The requested URL returned error: 404" }; },
      sleep: () => assert.fail("404 must not retry"), log() {},
    }),
  }), /404/);
  assert.equal(attempts, 1);
  assert.deepEqual(readdirSync(root), []);
});
test("v2 valid pinned receipt avoids downloading, extracting or signing again", async t => {
  const root = directory(t);
  const bytes = Buffer.from("cached binary");
  writeFileSync(join(root, "opencode2"), bytes);
  writeFileSync(join(root, "opencode2-integrity.json"), JSON.stringify({
    integrity: artifacts.platforms["darwin-arm64"].integrity,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  assert.equal(await prepareOpencodeV2(root, "aarch64-apple-darwin", {
    download: () => assert.fail("valid cache must not download"),
  }), join(root, "opencode2"));
});
