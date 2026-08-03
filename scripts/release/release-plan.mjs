#!/usr/bin/env node

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function bumpVersion(currentVersion, bump) {
  const match = currentVersion.match(STABLE_VERSION);
  if (!match) throw new Error(`Invalid stable version: ${currentVersion}`);
  if (!["patch", "minor", "major"].includes(bump)) {
    throw new Error(`Invalid release bump: ${bump}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function createReleasePlan({ currentVersion, bump }) {
  const version = bumpVersion(currentVersion, bump);
  return {
    version,
    tag: `v${version}`,
    branch: `release/v${version}`,
  };
}

export function decideTagAction(existingSha, targetSha) {
  if (!/^[0-9a-f]{40}$/.test(targetSha)) {
    throw new Error(`Invalid target commit SHA: ${targetSha}`);
  }
  if (!existingSha) return "create";
  if (existingSha === targetSha) return "keep";
  throw new Error(`Tag already targets ${existingSha}, not ${targetSha}.`);
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const plan = createReleasePlan({
      currentVersion: readFlag("--current"),
      bump: readFlag("--bump"),
    });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
