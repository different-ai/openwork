import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const dirname = path.dirname(fileURLToPath(import.meta.url));

async function readConfig(name) {
  return YAML.parse(await readFile(path.resolve(dirname, "..", name), "utf8"));
}

async function readReleaseWorkflow() {
  return YAML.parse(
    await readFile(
      path.resolve(
        dirname,
        "../../..",
        ".github/workflows/release-macos-aarch64.yml",
      ),
      "utf8",
    ),
  );
}

describe("Electron distribution configs", () => {
  it("uses a stable Linux desktop identity and ships integration icons", async () => {
    const packageMetadata = JSON.parse(
      await readFile(path.resolve(dirname, "..", "package.json"), "utf8"),
    );
    const config = await readConfig("electron-builder.base.yml");
    assert.equal(packageMetadata.desktopName, "com.differentai.openwork");
    assert.equal(config.npmRebuild, false);
    assert.deepEqual(config.files.at(-1), {
      from: ".electron-runtime/node_modules",
      to: "node_modules",
    });
    assert.equal(config.linux.syncDesktopName, true);
    assert.equal(config.linux.icon, "resources/icons/linux");
    assert.deepEqual(config.linux.extraResources[0], {
      from: "resources/icons/linux",
      to: "icons/linux",
      filter: ["*.png"],
    });
  });

  it("keeps the public artifact and protocol unchanged", async () => {
    const config = await readConfig("electron-builder.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "com.differentai.openwork");
    assert.equal(config.productName, "OpenWork");
    assert.equal(config.protocols[0].schemes[0], "openwork");
    assert.equal(
      config.artifactName,
      "openwork-${os}-${arch}-${version}.${ext}",
    );
  });

  it("defines an enterprise flavor with the standard app identity and release provider", async () => {
    const config = await readConfig("electron-builder.enterprise.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "com.differentai.openwork");
    assert.equal(config.productName, "OpenWork Enterprise");
    assert.equal(config.extraMetadata.openworkDistribution, "enterprise");
    assert.equal(config.protocols[0].schemes[0], "openwork");
    assert.equal(config.publish[0].provider, "github");
    assert.equal(config.publish[0].owner, "different-ai");
    assert.equal(config.publish[0].repo, "openwork");
    assert.equal(config.publish[0].channel, "enterprise");
    assert.equal(
      config.artifactName,
      "openwork-enterprise-${os}-${arch}-${version}.${ext}",
    );
  });

  it("defines a Cloud flavor with its own artifacts and updater channel", async () => {
    const config = await readConfig("electron-builder.cloud.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "com.differentai.openwork");
    assert.equal(config.productName, "OpenWork Cloud");
    assert.equal(config.extraMetadata.openworkDistribution, "cloud");
    assert.equal(config.protocols[0].schemes[0], "openwork");
    assert.equal(config.publish[0].channel, "cloud");
    assert.equal(
      config.artifactName,
      "openwork-cloud-${os}-${arch}-${version}.${ext}",
    );
  });

  it("installs both macOS CPU variants for Electron releases", async () => {
    const workflow = await readReleaseWorkflow();
    const publishElectron = workflow.jobs["publish-electron"];
    const matrix = publishElectron.strategy.matrix.include;
    const steps = publishElectron.steps;
    const macosArtifacts = matrix
      .filter(({ os_type: osType }) => osType === "macos")
      .map(({ artifact }) => artifact);

    assert.ok(macosArtifacts.includes("electron-macos-arm64"));
    assert.ok(macosArtifacts.includes("electron-macos-x64"));

    const macosInstall = steps.find(
      ({ name }) => name === "Install dependencies (macOS)",
    );
    assert.equal(macosInstall.if, "matrix.os_type == 'macos'");
    assert.match(macosInstall.run, /pnpm install --frozen-lockfile/);
    assert.match(macosInstall.run, /--cpu=arm64/);
    assert.match(macosInstall.run, /--cpu=x64/);

    const nativeInstall = steps.find(
      ({ name }) => name === "Install dependencies (Linux and Windows)",
    );
    assert.equal(nativeInstall.if, "matrix.os_type != 'macos'");
    assert.equal(nativeInstall.run, "pnpm install --frozen-lockfile");
  });
});
