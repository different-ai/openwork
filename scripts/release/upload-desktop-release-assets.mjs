import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const EXTENSIONS = {
  app: ".app.tar.gz",
  deb: ".deb",
  dmg: ".dmg",
  msi: ".msi",
  rpm: ".rpm",
};

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function parseArgs(argv) {
  const args = { repo: process.env.GITHUB_REPOSITORY || "", tag: "", artifactsDir: "" };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--repo") {
      args.repo = next;
      i += 1;
    } else if (arg === "--tag") {
      args.tag = next;
      i += 1;
    } else if (arg === "--artifacts-dir") {
      args.artifactsDir = next;
      i += 1;
    }
  }

  if (!args.repo) fail("Missing --repo.");
  if (!args.tag) fail("Missing --tag.");
  if (!args.artifactsDir) fail("Missing --artifacts-dir.");

  return args;
}

function parseArtifactName(name) {
  const prefix = "desktop-release-";
  if (!name.startsWith(prefix)) return null;

  const parts = name.slice(prefix.length).split("-");
  if (parts.length < 3) return null;

  const bundle = parts.at(-1);
  const platform = parts[0];
  const arch = parts.slice(1, -1).join("-");

  if (!platform || !arch || !(bundle in EXTENSIONS)) return null;

  return { platform, arch, bundle };
}

async function main() {
  const { repo, tag, artifactsDir } = parseArgs(process.argv.slice(2));
  const artifactDirs = await readdir(artifactsDir, { withFileTypes: true });

  for (const artifactDir of artifactDirs) {
    if (!artifactDir.isDirectory()) continue;

    const parsed = parseArtifactName(artifactDir.name);
    if (!parsed) continue;

    const bundleExt = EXTENSIONS[parsed.bundle];
    if (!bundleExt) {
      fail(`Unsupported bundle type in artifact name: ${artifactDir.name}`);
    }

    const fullDir = path.join(artifactsDir, artifactDir.name);
    const files = await listFiles(fullDir);
    const primaryFile = files.find((file) => file.endsWith(bundleExt));

    if (!primaryFile) {
      fail(`Missing ${bundleExt} file in ${artifactDir.name}`);
    }

    const signatureFile = files.find((file) => file === `${primaryFile}.sig` || file.endsWith(`${bundleExt}.sig`));
    const releaseName = `openwork-desktop-${parsed.platform}-${parsed.arch}${bundleExt}`;

    run("gh", ["release", "upload", tag, `${primaryFile}#${releaseName}`, "--repo", repo, "--clobber"]);

    if (signatureFile) {
      run("gh", ["release", "upload", tag, `${signatureFile}#${releaseName}.sig`, "--repo", repo, "--clobber"]);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
