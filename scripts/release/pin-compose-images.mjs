#!/usr/bin/env node
/**
 * Rewrites the image pins of the pull-only evaluation stack
 * (packaging/docker/docker-compose.eval.yml) and the commit + checksum the
 * docs use to download that file. Nothing in the release pipeline stamps this
 * file (versions live in git tags; see stamp-version.mjs), so a job in
 * publish-ee-images.yml calls this after the tagged images are pushed and
 * opens a pull request against dev with the result.
 *
 * Usage:
 *   node scripts/release/pin-compose-images.mjs pin --version X.Y.Z \
 *     --digest openwork-den-api=sha256:... --digest openwork-den-web=sha256:...
 *   node scripts/release/pin-compose-images.mjs docs --commit <40-hex sha>
 *
 * `pin` rewrites every ghcr.io/different-ai/openwork-* image line to
 * <image>:<version>@<digest> and requires a digest for each image found.
 * `docs` recomputes the compose file's sha256 and rewrites the raw.githubusercontent
 * commit URL and checksum in the documents that tell evaluators to download it.
 * The commit must already contain the rewritten compose file, so the caller
 * commits the `pin` result first and passes that commit's sha.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const COMPOSE_PATH = "packaging/docker/docker-compose.eval.yml";
export const DOC_PATHS = [
  "packages/docs/self-host/evaluate-with-docker-compose.mdx",
  "packaging/docker/README.md",
];
export const PINNED_IMAGES = ["openwork-den-api", "openwork-den-web"];

const IMAGE_LINE_PATTERN = /^(\s*image:\s*ghcr\.io\/different-ai\/)(openwork-[a-z-]+):([0-9A-Za-z._-]+)@(sha256:[0-9a-f]{64})\s*$/gm;
const RAW_URL_PATTERN = /(https:\/\/raw\.githubusercontent\.com\/different-ai\/openwork\/)([0-9a-f]{40})(\/packaging\/docker\/docker-compose\.eval\.yml)/g;
const CHECKSUM_PATTERN = /'([0-9a-f]{64})'(\s*\\\s*\n\s*'docker-compose\.eval\.yml' \| shasum -a 256 --check)/g;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function readComposePins(composeText) {
  return Array.from(composeText.matchAll(IMAGE_LINE_PATTERN), (match) => ({
    image: match[2],
    tag: match[3],
    digest: match[4],
  }));
}

export function rewriteComposePins(composeText, { version, digests }) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid stable version: ${version || "(empty)"} (expected X.Y.Z)`);
  }
  for (const [image, digest] of Object.entries(digests)) {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new Error(`Invalid digest for ${image}: ${digest} (expected sha256:<64 hex>)`);
    }
  }

  const found = new Set();
  const text = composeText.replace(IMAGE_LINE_PATTERN, (line, prefix, image) => {
    const digest = digests[image];
    if (!digest) {
      throw new Error(`No digest provided for ${image}, which is pinned in ${COMPOSE_PATH}`);
    }
    found.add(image);
    return `${prefix}${image}:${version}@${digest}`;
  });

  for (const image of PINNED_IMAGES) {
    if (!found.has(image)) {
      throw new Error(`Expected a pinned ${image} image line in ${COMPOSE_PATH}; none found`);
    }
  }
  return text;
}

export function readDocReferences(docText) {
  const commits = Array.from(docText.matchAll(RAW_URL_PATTERN), (match) => match[2]);
  const checksums = Array.from(docText.matchAll(CHECKSUM_PATTERN), (match) => match[1]);
  return { commits, checksums };
}

export function rewriteDocReferences(docText, { commit, checksum }) {
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`Invalid commit sha: ${commit || "(empty)"} (expected 40 hex characters)`);
  }
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error(`Invalid checksum: ${checksum || "(empty)"} (expected 64 hex characters)`);
  }
  const { commits, checksums } = readDocReferences(docText);
  if (commits.length === 0 || checksums.length === 0) {
    throw new Error("Document has no compose download URL and checksum to rewrite");
  }
  return docText
    .replace(RAW_URL_PATTERN, `$1${commit}$3`)
    .replace(CHECKSUM_PATTERN, `'${checksum}'$2`);
}

function readArgValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readArgValues(args, flag) {
  const values = [];
  args.forEach((arg, index) => {
    if (arg === flag && args[index + 1] !== undefined) values.push(args[index + 1]);
  });
  return values;
}

function pinCommand(args, rootDir) {
  const version = readArgValue(args, "--version");
  const digests = {};
  for (const entry of readArgValues(args, "--digest")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid --digest ${entry} (expected image=sha256:...)`);
    digests[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  if (!version || Object.keys(digests).length === 0) {
    throw new Error("Usage: pin-compose-images.mjs pin --version X.Y.Z --digest <image>=sha256:... [--digest ...]");
  }
  const composePath = resolve(rootDir, COMPOSE_PATH);
  const rewritten = rewriteComposePins(readFileSync(composePath, "utf8"), { version, digests });
  writeFileSync(composePath, rewritten);
  return { version, pins: readComposePins(rewritten), files: [COMPOSE_PATH] };
}

function docsCommand(args, rootDir) {
  const commit = readArgValue(args, "--commit");
  if (!commit) throw new Error("Usage: pin-compose-images.mjs docs --commit <sha>");
  const checksum = sha256Hex(readFileSync(resolve(rootDir, COMPOSE_PATH), "utf8"));
  for (const relativePath of DOC_PATHS) {
    const docPath = resolve(rootDir, relativePath);
    writeFileSync(docPath, rewriteDocReferences(readFileSync(docPath, "utf8"), { commit, checksum }));
  }
  return { commit, checksum, files: DOC_PATHS };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const result = command === "pin"
    ? pinCommand(args, root)
    : command === "docs"
      ? docsCommand(args, root)
      : null;
  if (!result) throw new Error("Usage: pin-compose-images.mjs pin ... | docs ...");
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
