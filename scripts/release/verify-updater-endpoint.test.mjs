import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseArgs, validateUpdaterManifest } from "./verify-updater-endpoint.mjs";

const validManifest = {
  version: "0.12.0",
  pub_date: "2026-04-28T00:00:00Z",
  platforms: {
    "darwin-aarch64": {
      signature: "signed",
      url: "https://example.com/openwork.app.tar.gz",
    },
  },
};

const releaseWorkflow = readFileSync(new URL("../../.github/workflows/release-macos-aarch64.yml", import.meta.url), "utf8");
const alphaWorkflow = readFileSync(new URL("../../.github/workflows/alpha-macos-aarch64.yml", import.meta.url), "utf8");
const publishReleaseStep = releaseWorkflow.match(/publish-release:[\s\S]*?verify-stable-updater-feed:/)?.[0] || "";

test("accepts a valid updater manifest", () => {
  assert.deepEqual(validateUpdaterManifest(validManifest, { platform: "darwin-aarch64" }), []);
});

test("rejects missing required fields", () => {
  assert.deepEqual(validateUpdaterManifest({}), [
    "version must be a non-empty string",
    "pub_date must be a non-empty string",
    "platforms must be a non-empty object",
  ]);
});

test("rejects invalid dates and empty platforms", () => {
  assert.deepEqual(
    validateUpdaterManifest({
      version: "0.12.0",
      pub_date: "not-a-date",
      platforms: {},
    }),
    ["pub_date must be a valid date string", "platforms must contain at least one platform"],
  );
});

test("rejects missing expected platform", () => {
  assert.deepEqual(validateUpdaterManifest(validManifest, { platform: "windows-x86_64" }), [
    "platforms must include windows-x86_64",
  ]);
});

test("rejects the wrong release version", () => {
  assert.deepEqual(validateUpdaterManifest(validManifest, { version: "0.12.1" }), [
    "version must be 0.12.1",
  ]);
  assert.deepEqual(validateUpdaterManifest(validManifest, { version: "v0.12.0" }), []);
});

test("rejects asset urls from a different release tag", () => {
  assert.deepEqual(validateUpdaterManifest(validManifest, { assetTag: "v0.12.0" }), [
    "platform darwin-aarch64 url must point at v0.12.0",
  ]);
  assert.deepEqual(
    validateUpdaterManifest(
      {
        ...validManifest,
        platforms: {
          "darwin-aarch64": {
            signature: "signed",
            url:
              "https://github.com/different-ai/openwork/releases/download/v0.12.0/" +
              "openwork-desktop-darwin-aarch64.app.tar.gz",
          },
        },
      },
      { assetTag: "v0.12.0" },
    ),
    [],
  );
});

test("rejects missing platforms from a required platform set", () => {
  assert.deepEqual(
    validateUpdaterManifest(validManifest, {
      platforms: ["darwin-aarch64", "darwin-x86_64", "linux-x86_64"],
    }),
    ["platforms must include darwin-x86_64", "platforms must include linux-x86_64"],
  );
});

test("rejects platform entries without signatures", () => {
  const manifest = {
    ...validManifest,
    platforms: {
      "darwin-aarch64": {
        url: "https://example.com/openwork.app.tar.gz",
      },
    },
  };

  assert.deepEqual(validateUpdaterManifest(manifest), [
    "platform darwin-aarch64 must include a non-empty signature",
  ]);
});

test("rejects platform entries without urls", () => {
  const manifest = {
    ...validManifest,
    platforms: {
      "darwin-aarch64": {
        signature: "signed",
      },
    },
  };

  assert.deepEqual(validateUpdaterManifest(manifest), ["platform darwin-aarch64 must include a non-empty url"]);
});

test("rejects platform entries that are not objects", () => {
  const manifest = {
    ...validManifest,
    platforms: {
      "darwin-aarch64": null,
    },
  };

  assert.deepEqual(validateUpdaterManifest(manifest), ["platform darwin-aarch64 must be an object"]);
});

test("rejects invalid source arguments", () => {
  assert.throws(
    () => parseArgs(["node", "verify-updater-endpoint.mjs"]),
    /Missing updater manifest source/,
  );
  assert.throws(
    () => parseArgs(["node", "verify-updater-endpoint.mjs", "--file", "latest.json", "--url", "https://example.com/latest.json"]),
    /Use either --file or --url/,
  );
});

test("parses comma-separated expected platforms", () => {
  const options = parseArgs([
    "node",
    "verify-updater-endpoint.mjs",
    "--file",
    "latest.json",
    "--platform",
    "darwin-aarch64,linux-x86_64",
    "--version",
    "v0.12.0",
    "--asset-tag",
    "v0.12.0",
  ]);

  assert.deepEqual(options.platforms, ["darwin-aarch64", "linux-x86_64"]);
  assert.equal(options.version, "v0.12.0");
  assert.equal(options.assetTag, "v0.12.0");
});

test("rejects invalid retry arguments", () => {
  assert.throws(
    () => parseArgs(["node", "verify-updater-endpoint.mjs", "--file", "latest.json", "--attempts", "0"]),
    /--attempts must be a positive integer/,
  );
  assert.throws(
    () => parseArgs(["node", "verify-updater-endpoint.mjs", "--file", "latest.json", "--delay-ms", "-1"]),
    /--delay-ms must be a non-negative integer/,
  );
  assert.throws(
    () => parseArgs(["node", "verify-updater-endpoint.mjs", "--file", "latest.json", "--timeout-ms", "0"]),
    /--timeout-ms must be a positive integer/,
  );
});

test("release creation does not claim GitHub Latest before manifests are ready", () => {
  assert.match(releaseWorkflow, /gh release create[\s\S]*--latest=false[\s\S]*\$DRAFT_FLAG \$PRERELEASE_FLAG/);
  assert.doesNotMatch(releaseWorkflow, /needs\.resolve-release\.outputs\.draft == 'true'/);
  assert.match(publishReleaseStep, /needs\.publish-updater-json\.result == 'success'/);
  assert.match(publishReleaseStep, /needs\.publish-electron\.result == 'success'/);
  assert.doesNotMatch(publishReleaseStep, /RELEASE_BUILD_TAURI/);
  assert.match(publishReleaseStep, /payload\.make_latest = "false"[\s\S]*else \{[\s\S]*payload\.make_latest = "true"/);
  assert.match(releaseWorkflow, /OPENWORK_STABLE_UPDATER_PLATFORMS:.*darwin-aarch64/);
  assert.match(releaseWorkflow, /--platform "\$OPENWORK_STABLE_UPDATER_PLATFORMS"/);
  assert.match(releaseWorkflow, /--version "\$\{RELEASE_TAG#v\}"/);
  assert.match(releaseWorkflow, /--asset-tag "\$RELEASE_TAG"/);
  assert.match(releaseWorkflow, /needs\.publish-release\.result == 'success'/);
});

test("sidecar releases cannot replace the desktop latest release", () => {
  assert.match(releaseWorkflow, /gh release create "\$tag"[\s\S]*--latest=false/);
  assert.match(releaseWorkflow, /Keep orchestrator release out of GitHub latest/);
  assert.match(releaseWorkflow, /"make_latest":\s*"false"/);
});

test("alpha release uploads the endpoint asset as latest.json", () => {
  assert.doesNotMatch(alphaWorkflow, /alpha-latest\.json#latest\.json/);
  assert.match(alphaWorkflow, /"\$RUNNER_TEMP\/latest\.json"/);
  assert.match(alphaWorkflow, /verify-updater-endpoint\.mjs[\s\S]*--file "\$RUNNER_TEMP\/latest\.json"/);
  assert.match(alphaWorkflow, /releases\/download\/\$\{ALPHA_RELEASE_TAG\}\/latest\.json/);
});
