import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "..", "package.json");

function normalizeVersion(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
}

function readPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function writePackageJson(pkg) {
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

async function fetchLatestVersion(repo, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openwork-opencode-version",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
    if (res.ok) {
      const data = await res.json();
      const tag = typeof data?.tag_name === "string" ? data.tag_name : "";
      return normalizeVersion(tag);
    }
    if (res.status !== 403) {
      throw new Error(`Failed to resolve latest OpenCode version (HTTP ${res.status})`);
    }
  } catch {
    // Fall through to web redirect.
  }

  const web = await fetch(`https://github.com/${repo}/releases/latest`, {
    headers: { "User-Agent": "openwork-opencode-version" },
    redirect: "follow",
  });
  const match = String(web.url || "").match(/\/tag\/v([^/?#]+)/);
  if (!match) {
    throw new Error(`Failed to resolve latest OpenCode version for ${repo}`);
  }
  return normalizeVersion(match[1]);
}

function parseArgs(argv) {
  const args = { command: "resolve", version: null, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "resolve" || arg === "set") && i === 0) {
      args.command = arg;
      continue;
    }
    if (arg === "--version") {
      args.version = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--repo") {
      args.repo = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return args;
}

async function resolveConfiguredVersion(repo) {
  const pkg = readPackageJson();
  const configuredRaw =
    process.env.OPENCODE_VERSION?.trim() || String(pkg.opencodeVersion ?? "").trim();

  if (configuredRaw && configuredRaw.toLowerCase() !== "latest") {
    return normalizeVersion(configuredRaw);
  }

  return fetchLatestVersion(repo, process.env.GITHUB_TOKEN?.trim());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = readPackageJson();
  const repo =
    args.repo?.trim() ||
    process.env.OPENCODE_GITHUB_REPO?.trim() ||
    process.env.OPENWORK_OPENCODE_GITHUB_REPO?.trim() ||
    "anomalyco/opencode";

  if (args.command === "set") {
    const nextVersion = normalizeVersion(args.version);
    if (!nextVersion) {
      throw new Error("A version is required for 'set'");
    }
    pkg.opencodeVersion = nextVersion;
    writePackageJson(pkg);
    process.stdout.write(`${nextVersion}\n`);
    return;
  }

  const resolved = await resolveConfiguredVersion(repo);
  if (!resolved) {
    throw new Error("Unable to resolve OpenCode version");
  }
  process.stdout.write(`${resolved}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
