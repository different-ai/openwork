#!/usr/bin/env node

const ARCH_ALIASES = new Map([
  ["x64", "x86_64"],
  ["amd64", "x86_64"],
  ["arm64", "aarch64"],
]);

function normalizeArch(arch) {
  const key = String(arch || "").trim().toLowerCase();
  return ARCH_ALIASES.get(key) || key;
}

function parseArgs(argv) {
  const options = {
    tag: process.env.RELEASE_TAG || "",
    repo: process.env.GITHUB_REPOSITORY || "different-ai/openwork",
    output: "latest.json",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag") {
      options.tag = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg === "--repo") {
      options.repo = argv[i + 1] || options.repo;
      i += 1;
      continue;
    }
    if (arg === "--output") {
      options.output = argv[i + 1] || options.output;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.tag) {
    throw new Error("Missing release tag. Pass --tag vX.Y.Z or set RELEASE_TAG.");
  }

  return options;
}

function updaterPlatformKeys(assetName) {
  if (!assetName.startsWith("openwork-desktop-")) return [];

  const stem = assetName.slice("openwork-desktop-".length);

  if (stem.endsWith(".app.tar.gz")) {
    const match = stem.match(/^([^-]+)-([^.]+)\.app\.tar\.gz$/);
    if (!match) return [];
    const platform = match[1];
    const arch = normalizeArch(match[2]);
    const base = `${platform}-${arch}`;
    if (platform === "darwin") {
      return [base, `${base}-app`];
    }
    return [base];
  }

  if (stem.endsWith(".msi")) {
    const match = stem.match(/^([^-]+)-([^.]+)\.msi$/);
    if (!match) return [];
    const platform = match[1];
    const arch = normalizeArch(match[2]);
    const base = `${platform}-${arch}`;
    return [base, `${base}-msi`];
  }

  if (stem.endsWith(".deb")) {
    const match = stem.match(/^([^-]+)-([^.]+)\.deb$/);
    if (!match) return [];
    const platform = match[1];
    const arch = normalizeArch(match[2]);
    const base = `${platform}-${arch}`;
    return [base, `${base}-deb`];
  }

  if (stem.endsWith(".rpm")) {
    const match = stem.match(/^([^-]+)-([^.]+)\.rpm$/);
    if (!match) return [];
    const platform = match[1];
    const arch = normalizeArch(match[2]);
    return [`${platform}-${arch}-rpm`];
  }

  if (stem.endsWith(".AppImage")) {
    const match = stem.match(/^([^-]+)-([^.]+)\.AppImage$/);
    if (!match) return [];
    const platform = match[1];
    const arch = normalizeArch(match[2]);
    return [`${platform}-${arch}`];
  }

  return [];
}

function authHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openwork-release-latest-json",
  };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}): ${url}`);
  }
  return response.json();
}

async function fetchReleaseByTag(repo, tag) {
  const encodedTag = encodeURIComponent(tag);
  const releaseByTagUrl = `https://api.github.com/repos/${repo}/releases/tags/${encodedTag}`;

  const byTagResponse = await fetch(releaseByTagUrl, { headers: authHeaders() });
  if (byTagResponse.ok) {
    return byTagResponse.json();
  }

  if (byTagResponse.status !== 404) {
    throw new Error(`GitHub API request failed (${byTagResponse.status}): ${releaseByTagUrl}`);
  }

  // Draft releases are not returned by /releases/tags/{tag}; fall back to paginated releases list.
  for (let page = 1; page <= 10; page += 1) {
    const listUrl = `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`;
    const releases = await fetchJson(listUrl);
    if (!Array.isArray(releases) || releases.length === 0) break;

    const match = releases.find((release) => {
      const candidate = String(release?.tag_name || "");
      return candidate === tag;
    });
    if (match) return match;
  }

  throw new Error(`Release ${repo}@${tag} not found (including drafts).`);
}

function releaseAssetUrl(repo, tag, assetName) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${assetName}`;
}

async function fetchText(url, accept = "text/plain") {
  const headers = authHeaders();
  headers.Accept = accept;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to download signature (${response.status}): ${url}`);
  }
  return response.text();
}

function sortObjectEntries(input) {
  const sorted = {};
  for (const key of Object.keys(input).sort()) {
    sorted[key] = input[key];
  }
  return sorted;
}

async function main() {
  const { tag, repo, output } = parseArgs(process.argv);
  const release = await fetchReleaseByTag(repo, tag);

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const assetsByName = new Map();
  for (const asset of assets) {
    if (asset && typeof asset.name === "string") {
      assetsByName.set(asset.name, asset);
    }
  }

  const platforms = {};

  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || !asset.name.endsWith(".sig")) continue;

    const targetName = asset.name.slice(0, -4);
    const targetAsset = assetsByName.get(targetName);
    if (!targetAsset) continue;

    const keys = updaterPlatformKeys(targetName);
    if (!keys.length) continue;

    if (typeof asset.url !== "string") continue;

    const signature = (await fetchText(asset.url, "application/octet-stream")).trim();
    if (!signature) continue;

    const url = releaseAssetUrl(repo, tag, targetName);

    for (const key of keys) {
      platforms[key] = {
        signature,
        url,
      };
    }
  }

  if (!Object.keys(platforms).length) {
    throw new Error(`No updater platforms were resolved for ${repo}@${tag}.`);
  }

  const version = String(release.tag_name || tag).replace(/^v/, "");
  const latest = {
    version,
    notes:
      typeof release.body === "string" && release.body.trim()
        ? release.body
        : "See the assets to download this version and install.",
    pub_date: release.published_at || new Date().toISOString(),
    platforms: sortObjectEntries(platforms),
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile(output, `${JSON.stringify(latest, null, 2)}\n`, "utf8");

  console.log(`Wrote ${output} with ${Object.keys(latest.platforms).length} updater platforms.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
