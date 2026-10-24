import { isDeepStrictEqual } from "node:util";
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const PACKAGE_PATH = "integrations/agent-plugins/openwork-connect";
export const PACKAGE_FILES = [
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".mcp.json",
  "LICENSE",
  "README.md",
  "assets/logo.svg",
  "mcp.json",
  "plugin.json",
  "skills/openwork-connect/SKILL.md",
];
export const MARKETPLACE_FILES = [
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
];
const ENDPOINT = "https://api.openworklabs.com/mcp/agent";
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function requireEqual(actual, expected, label) {
  requireCondition(isDeepStrictEqual(actual, expected), `${label} differs from the supported packaging shape`);
}

function inside(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

function fileExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function regularFile(root, path) {
  requireCondition(!isAbsolute(path) && !path.split(/[\\/]/).includes(".."), `Unsafe package path: ${path}`);
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    requireCondition(!stat.isSymbolicLink(), `Symbolic links are not exported: ${path}`);
  }
  requireCondition(lstatSync(current).isFile(), `Expected a regular file: ${path}`);
  return readFileSync(current);
}

function inventory(root, prefix = "") {
  return readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(root, path));
    requireCondition(!stat.isSymbolicLink(), `Symbolic links are not exported: ${path}`);
    requireCondition(stat.isDirectory() || stat.isFile(), `Unsupported package entry: ${path}`);
    return stat.isDirectory() ? inventory(root, path) : [path];
  }).sort();
}

function json(files, path) {
  return JSON.parse(files.get(path).toString("utf8"));
}

function validateCatalog(catalog, kind, plugin, source) {
  const entry = {
    name: plugin.name,
    source,
    description: "Use your organization's OpenWork skills and connections.",
  };
  if (kind === "codex") {
    requireEqual(catalog, {
      name: "openwork",
      interface: { displayName: "OpenWork" },
      plugins: [{
        name: plugin.name,
        source: { source: "local", path: source },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      }],
    }, "Codex marketplace");
  } else {
    requireEqual(catalog, {
      name: "openwork",
      ...(kind === "Claude" ? { description: "OpenWork Connect skills and organization-scoped MCP connections." } : {}),
      owner: { name: plugin.author.name },
      plugins: [entry],
    }, `${kind} marketplace`);
  }
}

// These offline invariants validate this package, not every upstream plugin schema.
export function validateDistribution(sourceRoot = REPOSITORY_ROOT, { standalone = false } = {}) {
  const root = realpathSync(sourceRoot);
  const packageRoot = standalone ? root : join(root, PACKAGE_PATH);
  if (!standalone) {
    // Check every ancestor as well as files; a linked package directory must not escape.
    regularFile(root, `${PACKAGE_PATH}/plugin.json`);
  }
  const expectedFiles = standalone ? [...PACKAGE_FILES, ...MARKETPLACE_FILES] : PACKAGE_FILES;
  requireEqual(inventory(packageRoot), [...expectedFiles].sort(), "Package file allowlist");
  const files = new Map(PACKAGE_FILES.map((path) => [path, regularFile(packageRoot, path)]));
  const catalogs = MARKETPLACE_FILES.map((path) => JSON.parse(regularFile(root, path).toString("utf8")));
  const plugin = json(files, "plugin.json");
  requireEqual(Object.keys(plugin).sort(), [
    "$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords",
  ].sort(), "Portable manifest fields (no secrets or executable components)");
  requireEqual(plugin.$schema, PLUGIN_SCHEMA, "Portable manifest schema");
  requireEqual(plugin.name, "openwork-connect", "Plugin name");
  requireEqual(plugin.license, "MIT", "Plugin license");
  requireEqual(plugin.author, { name: "OpenWork", url: "https://openworklabs.com" }, "Publisher");
  requireCondition(/^\d+\.\d+\.\d+$/.test(plugin.version), "Expected a release version");
  requireCondition(typeof plugin.description === "string" && plugin.description.length > 0, "Missing description");
  for (const key of ["homepage", "repository"]) {
    const url = new URL(plugin[key]);
    requireCondition(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, `Unsafe ${key}`);
  }
  const { $schema, ...nativeMetadata } = plugin;
  requireEqual(json(files, ".claude-plugin/plugin.json"), {
    ...nativeMetadata, icon: "./assets/logo.svg",
  }, "Claude native manifest");
  requireEqual(json(files, ".cursor-plugin/plugin.json"), {
    ...nativeMetadata, author: { name: plugin.author.name },
    logo: "./assets/logo.svg", mcpServers: "./.mcp.json",
  }, "Cursor native manifest");
  requireEqual(json(files, "mcp.json"), {
    $schema: MCP_SCHEMA,
    mcpServers: { openwork: { type: "streamable-http", url: ENDPOINT } },
  }, "Portable MCP configuration (no credentials)");
  requireEqual(json(files, ".mcp.json"), {
    mcpServers: { openwork: { type: "http", url: ENDPOINT } },
  }, "Native MCP configuration (no credentials)");
  const source = standalone ? "./" : `./${PACKAGE_PATH}`;
  catalogs.forEach((catalog, index) => validateCatalog(catalog, ["Claude", "Cursor", "codex"][index], plugin, source));

  const readme = files.get("README.md").toString("utf8");
  requireCondition(readme.replace(/```[\s\S]*?```/g, "").trim().split(/\s+/).length >= 40, "README needs at least 40 words outside code blocks");
  const skill = files.get("skills/openwork-connect/SKILL.md").toString("utf8");
  requireCondition(/^---\nname: openwork-connect\ndescription: [^\n]+\n---\n/.test(skill), "Invalid shared skill frontmatter");
  requireCondition(skill.includes("Never request, embed,"), "Shared skill must keep the no-token handling instruction");
  const license = files.get("LICENSE").toString("utf8");
  requireCondition(license.startsWith("MIT License\n") && license.includes("THE SOFTWARE IS PROVIDED"), "Missing MIT license text");
  const logo = files.get("assets/logo.svg").toString("utf8");
  requireCondition(logo.includes('viewBox="0 0 1024 1024"'), "Expected the committed square desktop logo");
  requireCondition(!/<script\b|<foreignObject\b|<!ENTITY\b|\bon\w+=|(?:href|src)=/i.test(logo), "Logo must not load external content or scripts");
  if (!standalone) {
    requireEqual(files.get("assets/logo.svg"), regularFile(root, "apps/app/public/openwork-logo-square.svg"), "MIT desktop logo provenance");
    requireCondition(regularFile(root, "LICENSE").toString("utf8").includes(license.trim()), "Package license must match the root MIT grant");
  }
  for (const [path, contents] of files) {
    const text = contents.toString("utf8");
    requireCondition(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{20,}|["'](?:access_token|refresh_token|client_secret|api_key|password)["']\s*:\s*["'][^"']+["']/i.test(text), `Possible credential in ${path}`);
  }
  return { files, catalogs, version: plugin.version };
}

export function exportDistribution(output, { sourceRoot = REPOSITORY_ROOT } = {}) {
  requireCondition(typeof output === "string" && isAbsolute(output), "--output must be an explicit absolute path outside Git checkouts");
  requireCondition(!output.split(/[\\/]/).includes(".."), "--output must not contain path traversal");
  const requested = resolve(output);
  requireCondition(!fileExists(requested), "Output already exists; refusing to overwrite it");
  const parent = realpathSync(dirname(requested));
  const destination = join(parent, basename(requested));
  requireCondition(!inside(realpathSync(sourceRoot), destination), "Output must be outside the source checkout");
  for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
    requireCondition(!fileExists(join(ancestor, ".git")), "Output must be outside every Git checkout");
    if (dirname(ancestor) === ancestor) break;
  }
  const { files, catalogs } = validateDistribution(sourceRoot);
  for (const [index, path] of MARKETPLACE_FILES.entries()) {
    const catalog = structuredClone(catalogs[index]);
    if (index === 2) catalog.plugins[0].source.path = "./";
    else catalog.plugins[0].source = "./";
    files.set(path, Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`));
  }
  mkdirSync(destination, { mode: 0o755 });
  for (const [path, contents] of [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    writeFileSync(join(destination, path), contents, { flag: "wx", mode: 0o644 });
  }
  validateDistribution(destination, { standalone: true });
  return { directory: destination, files: [...files.keys()].sort(), bytes: [...files.values()].reduce((sum, file) => sum + file.length, 0) };
}

function main(args) {
  if (args.length === 1 && args[0] === "--check") {
    const { files, version } = validateDistribution();
    console.log(`Validated OpenWork Connect ${version}: ${files.size} package files and ${MARKETPLACE_FILES.length} repo catalogs (offline only).`);
    return;
  }
  if (args.length === 2 && args[0] === "--output") {
    console.log(JSON.stringify(exportDistribution(args[1]), null, 2));
    return;
  }
  throw new Error("Usage: node scripts/marketplaces/export-plugin.mjs --check | --output /absolute/new/directory");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
