import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = path.join(repoRoot, "docs/enterprise/outbound-access.json");
const docsPath = "docs/enterprise/outbound-access.md";

const scanRoots = [
  "apps/desktop/electron",
  "apps/server/src",
  "apps/app/src",
  "packages/openwork-bootstrap/bin",
];

const requiredFields = ["host", "kind", "components", "purpose", "requirement", "blockedEffect", "override"];
const allowedKinds = new Set(["fetched", "redirect-target", "subprocess", "link-only", "schema-string"]);
const allowedRequirements = new Set(["required", "required-for-cloud", "required-in-practice", "optional", "opt-in"]);
const urlHostPattern = /https:\/\/([A-Za-z0-9.-]+)(?::\d+)?(?=$|[\/?#"'`<>\s)\]},;$])/g;

function toRepoPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isTestFile(filePath) {
  const parts = filePath.split(path.sep);
  return parts.includes("__tests__") || path.basename(filePath).includes(".test.");
}

function ignoredHostReason(host) {
  const value = host.toLowerCase();

  if (!/[a-z0-9]/.test(value)) {
    return "placeholder hostname";
  }

  // RFC 2606 / reserved documentation names: these are examples, not real
  // customer allowlist requirements. This covers example.com/net/org and their
  // subdomains, example.* placeholders, and the reserved .example/.invalid/.test
  // suffixes used in docs and fixtures.
  if (
    value === "example.com" ||
    value === "example.net" ||
    value === "example.org" ||
    value.endsWith(".example.com") ||
    value.endsWith(".example.net") ||
    value.endsWith(".example.org") ||
    value.startsWith("example.") ||
    value.endsWith(".example") ||
    value === "invalid" ||
    value.endsWith(".invalid") ||
    value === "test" ||
    value.endsWith(".test")
  ) {
    return "reserved documentation hostname";
  }

  // Local development and loopback URLs are intentionally not customer network
  // destinations.
  if (value === "localhost" || value.endsWith(".localhost") || value === "127.0.0.1" || value.startsWith("127.")) {
    return "loopback/local development hostname";
  }

  // Standards/schema identifiers appear in manifests and XML/JSON metadata but
  // are not fetched by OpenWork at runtime.
  if (
    value === "w3.org" ||
    value.endsWith(".w3.org") ||
    value === "json-schema.org" ||
    value.endsWith(".json-schema.org") ||
    value === "schema.org" ||
    value.endsWith(".schema.org") ||
    value === "openxmlformats.org" ||
    value.endsWith(".openxmlformats.org")
  ) {
    return "standards/schema identifier hostname";
  }

  // Placeholder used in customer-facing self-hosted examples.
  if (value === "openwork.yourcompany.com") {
    return "customer placeholder hostname";
  }

  return null;
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (isTestFile(fullPath)) continue;
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath));
      continue;
    }
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function lineNumberForIndex(content, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

async function scanHosts() {
  const observed = new Map();
  const ignored = [];

  for (const root of scanRoots) {
    const rootPath = path.join(repoRoot, root);
    const info = await stat(rootPath);
    if (!info.isDirectory()) throw new Error(`Scan root is not a directory: ${root}`);

    const files = await listFiles(rootPath);
    files.sort((left, right) => toRepoPath(left).localeCompare(toRepoPath(right)));
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const match of content.matchAll(urlHostPattern)) {
        const host = match[1]?.toLowerCase().replace(/\.$/, "") ?? "";
        if (!host) continue;
        const occurrence = { file: toRepoPath(file), line: lineNumberForIndex(content, match.index ?? 0) };
        const reason = ignoredHostReason(host);
        if (reason) {
          ignored.push({ host, ...occurrence, reason });
          continue;
        }
        const existing = observed.get(host) ?? [];
        existing.push(occurrence);
        observed.set(host, existing);
      }
    }
  }

  return { observed, ignored };
}

async function readManifest() {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    errors.push(`Could not parse docs/enterprise/outbound-access.json: ${error instanceof Error ? error.message : String(error)}`);
    return { hosts: new Map(), errors };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push("docs/enterprise/outbound-access.json must contain an object.");
    return { hosts: new Map(), errors };
  }
  if (!Array.isArray(parsed.hosts)) {
    errors.push("docs/enterprise/outbound-access.json must contain a hosts array.");
    return { hosts: new Map(), errors };
  }

  const hosts = new Map();
  parsed.hosts.forEach((entry, index) => {
    const label = `hosts[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object.`);
      return;
    }

    for (const field of requiredFields) {
      if (!Object.hasOwn(entry, field)) errors.push(`${label} is missing required field "${field}".`);
    }

    const host = typeof entry.host === "string" ? entry.host.trim().toLowerCase() : "";
    if (!host) errors.push(`${label}.host must be a non-empty string.`);
    if (host.includes("://") || host.includes("/")) errors.push(`${label}.host must be a hostname, not a URL: ${entry.host}`);
    if (host && hosts.has(host)) errors.push(`Duplicate host in manifest: ${host}`);

    if (typeof entry.kind !== "string" || !allowedKinds.has(entry.kind)) {
      errors.push(`${label}.kind must be one of: ${[...allowedKinds].join(", ")}.`);
    }
    if (typeof entry.requirement !== "string" || !allowedRequirements.has(entry.requirement)) {
      errors.push(`${label}.requirement must be one of: ${[...allowedRequirements].join(", ")}.`);
    }
    if (!Array.isArray(entry.components) || entry.components.length === 0 || entry.components.some((component) => typeof component !== "string" || !component.trim())) {
      errors.push(`${label}.components must be a non-empty array of strings.`);
    }
    if (typeof entry.purpose !== "string" || !entry.purpose.trim()) errors.push(`${label}.purpose must be a non-empty string.`);
    if (typeof entry.blockedEffect !== "string" || !entry.blockedEffect.trim()) errors.push(`${label}.blockedEffect must be a non-empty string.`);
    if (entry.override !== null && typeof entry.override !== "string") errors.push(`${label}.override must be a string or null.`);

    if (host) hosts.set(host, entry);
  });

  return { hosts, errors };
}

function buildReport(manifest, scan) {
  const missing = [];
  const stale = [];

  for (const [host, occurrences] of scan.observed.entries()) {
    if (!manifest.hosts.has(host)) missing.push({ host, occurrences });
  }

  for (const [host, entry] of manifest.hosts.entries()) {
    if (entry.kind === "fetched" && !scan.observed.has(host)) stale.push({ host });
  }

  missing.sort((left, right) => left.host.localeCompare(right.host));
  stale.sort((left, right) => left.host.localeCompare(right.host));

  return {
    ok: manifest.errors.length === 0 && missing.length === 0 && stale.length === 0,
    manifestErrors: manifest.errors,
    missing,
    stale,
    observedHosts: [...scan.observed.keys()].sort(),
    manifestHosts: [...manifest.hosts.keys()].sort(),
    ignored: scan.ignored,
  };
}

function printText(report) {
  if (report.ok) {
    console.log(`Outbound access manifest covers ${report.manifestHosts.length} hosts. Scanned ${report.observedHosts.length} external hosts from shipped client surfaces. No stale fetched entries.`);
    return;
  }

  const lines = ["Outbound access manifest check failed."];
  for (const error of report.manifestErrors) lines.push(`- ${error}`);
  for (const item of report.missing) {
    const first = item.occurrences[0];
    lines.push(`- Host ${item.host} is used in ${first.file}:${first.line} but is missing from docs/enterprise/outbound-access.json. Add it to docs/enterprise/outbound-access.json (see ${docsPath}).`);
  }
  for (const item of report.stale) {
    lines.push(`- Manifest host ${item.host} has kind "fetched" but no https://${item.host} literal was found in the scan roots. Remove it from docs/enterprise/outbound-access.json or update its kind (see ${docsPath}).`);
  }
  console.error(lines.join("\n"));
}

function printJson(report) {
  const jsonReport = {
    ok: report.ok,
    manifestErrors: report.manifestErrors,
    missingHosts: report.missing.map((item) => ({ host: item.host, occurrences: item.occurrences })),
    staleFetchedHosts: report.stale.map((item) => item.host),
    observedHosts: report.observedHosts,
    manifestHosts: report.manifestHosts,
    ignoredHosts: report.ignored,
  };
  process.stdout.write(`${JSON.stringify(jsonReport, null, 2)}\n`);
}

const json = process.argv.includes("--json");
const manifest = await readManifest();
const scan = await scanHosts();
const report = buildReport(manifest, scan);

if (json) printJson(report);
else printText(report);

if (!report.ok) process.exitCode = 1;
