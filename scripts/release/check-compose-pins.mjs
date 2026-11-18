#!/usr/bin/env node
/**
 * Drift check for the pull-only evaluation stack. Fails when the den-api /
 * den-web images pinned in packaging/docker/docker-compose.eval.yml are not the
 * version this repository currently declares as released, or when the docs
 * that download that file carry a checksum for a different revision of it.
 *
 * The released version is the highest stable v* tag (scripts/release/versions.mjs
 * `latest`): git tags are the only place versions live, package.json holds a
 * permanent 0.0.0-dev placeholder, and the Release App workflow derives the
 * next version from the same helper. Needs a full tag fetch (fetch-depth 0).
 *
 * Usage:
 *   node scripts/release/check-compose-pins.mjs [--expected X.Y.Z]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPOSE_PATH,
  DOC_PATHS,
  PINNED_IMAGES,
  readComposePins,
  readDocReferences,
  sha256Hex,
} from "./pin-compose-images.mjs";
import { highestStableVersion, readStableTagVersions } from "./versions.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function checkComposePins({ composeText, docs, releasedVersion }) {
  const problems = [];
  const pins = readComposePins(composeText);
  for (const image of PINNED_IMAGES) {
    const imagePins = pins.filter((pin) => pin.image === image);
    if (imagePins.length === 0) {
      problems.push(`${COMPOSE_PATH}: no pinned ${image} image found`);
      continue;
    }
    for (const pin of imagePins) {
      if (pin.tag !== releasedVersion) {
        problems.push(`${COMPOSE_PATH}: ${image} is pinned to ${pin.tag} but the released version is ${releasedVersion}`);
      }
    }
  }

  const checksum = sha256Hex(composeText);
  const commits = new Set();
  for (const doc of docs) {
    const references = readDocReferences(doc.text);
    if (references.commits.length === 0 || references.checksums.length === 0) {
      problems.push(`${doc.path}: no compose download URL and checksum found`);
      continue;
    }
    references.commits.forEach((commit) => commits.add(commit));
    for (const documented of references.checksums) {
      if (documented !== checksum) {
        problems.push(`${doc.path}: documented checksum ${documented.slice(0, 12)}… does not match ${COMPOSE_PATH} (${checksum.slice(0, 12)}…)`);
      }
    }
  }
  if (commits.size > 1) {
    problems.push(`docs disagree on the compose download commit: ${[...commits].join(", ")}`);
  }

  return { ok: problems.length === 0, releasedVersion, pins, problems };
}

function main() {
  const args = process.argv.slice(2);
  const expectedIndex = args.indexOf("--expected");
  const releasedVersion = expectedIndex >= 0
    ? args[expectedIndex + 1]
    : highestStableVersion(readStableTagVersions(root));
  if (!releasedVersion) {
    throw new Error("No stable v* tags found (need a full clone: fetch-depth 0) and no --expected given.");
  }

  const result = checkComposePins({
    composeText: readFileSync(resolve(root, COMPOSE_PATH), "utf8"),
    docs: DOC_PATHS.map((path) => ({ path, text: readFileSync(resolve(root, path), "utf8") })),
    releasedVersion,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`Compose evaluation stack pins drift from the released version ${releasedVersion}.`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
