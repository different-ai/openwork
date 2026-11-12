#!/usr/bin/env node
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldPublishAlpha } from "./check-alpha-version.mjs";
import { createGithubReleaseClient } from "./github-release.mjs";

export async function publishAlphaAssets({ platform, dist, env = process.env, github = createGithubReleaseClient() }) {
  if (!["mac", "windows"].includes(platform)) throw new Error("--platform must be mac or windows.");
  const repo = env.GITHUB_REPOSITORY;
  const tag = env.CHANNEL_TAG;
  const version = env.ALPHA_VERSION;
  const prefix = platform === "mac" ? "alpha-macos-" : "alpha-windows-";
  if (!repo || !tag?.startsWith(prefix)) throw new Error(`Refusing to publish alpha assets outside ${prefix} tags.`);
  if (!version || !env.ALPHA_COMMIT || !env.ALPHA_BUILD_STARTED_AT || !env.GITHUB_SHA || !env.ALPHA_RELEASE_NAME) {
    throw new Error("Alpha version, provenance, target SHA and release name are required.");
  }
  // Validate the candidate even for a release that does not exist yet.
  shouldPublishAlpha(platform, version, []);
  const root = resolve(dist);
  const manifest = join(root, platform === "mac" ? "latest-mac.yml" : "latest.yml");
  const installer = join(root, `openwork-win-x64-${version}.exe`);
  const assets = platform === "mac"
    ? readdirSync(root).filter(name => /\.(?:dmg|zip|blockmap)$/.test(name)).sort().map(name => join(root, name))
    : [installer, `${installer}.blockmap`];
  if (assets.length === 0) throw new Error(`No Electron alpha assets found under ${root}.`);
  // Before any API mutation, require every asset and the final manifest.
  for (const file of [...assets, manifest]) {
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0) throw new Error(`Missing or empty alpha asset: ${file}`);
  }
  let release = await github.getRelease(repo, tag);
  if (release) {
    const published = await github.listAssets(repo, release.id);
    if (!shouldPublishAlpha(platform, version, published.map(asset => asset.name))) {
      console.log(`Skipping alpha ${version}: an equal or newer build is already uploaded.`);
      return false;
    }
  } else {
    await github.ensureRelease(repo, tag, [
      "--title", env.ALPHA_RELEASE_NAME,
      "--notes", `Rolling alpha channel for OpenWork ${platform === "mac" ? "macOS arm64" : "Windows x64"} builds. Each publish adds versioned updater assets and advances the channel manifest.`,
      "--target", env.GITHUB_SHA, "--prerelease",
      ...(platform === "windows" ? ["--latest=false"] : []),
    ]);
    release = await github.getRelease(repo, tag);
    if (!release) throw new Error(`Created release ${tag} could not be read back.`);
  }
  for (const file of assets) {
    const label = `${basename(file)} (commit ${env.ALPHA_COMMIT}; build started ${env.ALPHA_BUILD_STARTED_AT})`;
    if (platform === "windows") {
      await github.uploadImmutable(repo, tag, release.id, file, label);
    } else {
      await github.command(["release", "upload", tag, `${file}#${label}`, "--repo", repo, "--clobber"]);
    }
  }
  // Publish last: the feed must never advertise bytes that were not uploaded.
  await github.command(["release", "upload", tag, manifest, "--repo", repo, "--clobber"]);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "published=true\n");
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--platform" || args[2] !== "--dist") {
    console.error("Usage: publish-alpha-assets.mjs --platform <mac|windows> --dist <dist-root>");
    process.exitCode = 2;
  } else {
    try {
      await publishAlphaAssets({ platform: args[1], dist: args[3] });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
