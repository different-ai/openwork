import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const specsDirectory = new URL("../specs/", import.meta.url);
const profileUrl = new URL("../specs/daytona-e2e-regression-profile.json", import.meta.url);

const SINGLES_CATEGORIES = ["fresh-den-url", "fault-proxy"];

const SINGLES_DENYLIST = new Map([
  [
    "capability-search-latency.e2e.test.ts",
    "its fault proxy is built on the driver machine's loopback in front of a driver-local mock MCP; a Daytona-hosted Den can never reach it, so it is local-placement-only",
  ],
]);

function profileEntries(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("regression profile must be an object");
  }

  const excluded = Reflect.get(value, "excluded");
  if (!Array.isArray(excluded) || excluded.length === 0) {
    throw new Error("regression profile excluded must be a non-empty array");
  }

  return excluded.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`regression profile excluded[${index}] must be an object`);
    }

    const test = Reflect.get(entry, "test");
    const category = Reflect.get(entry, "category");
    if (typeof test !== "string" || test.length === 0) {
      throw new Error(`regression profile excluded[${index}].test must be a non-empty string`);
    }
    if (typeof category !== "string" || category.length === 0) {
      throw new Error(`regression profile excluded[${index}].category must be a non-empty string`);
    }

    return { test, category };
  });
}

export async function listSinglesTests() {
  let source;
  try {
    source = await readFile(profileUrl, "utf8");
  } catch (error) {
    throw new Error(`cannot read regression profile at ${fileURLToPath(profileUrl)}`, { cause: error });
  }

  let profile;
  try {
    profile = JSON.parse(source);
  } catch (error) {
    throw new Error(`regression profile is not valid JSON: ${fileURLToPath(profileUrl)}`, { cause: error });
  }

  const selected = profileEntries(profile)
    .filter(({ category, test }) => SINGLES_CATEGORIES.includes(category) && !SINGLES_DENYLIST.has(test))
    .map(({ test }) => test)
    .sort();

  if (selected.length === 0) {
    throw new Error("Daytona E2E singles selection is empty");
  }

  for (const test of selected) {
    try {
      await access(new URL(test, specsDirectory));
    } catch (error) {
      throw new Error(`selected singles spec does not exist: evals/specs/${test}`, { cause: error });
    }
  }

  return selected;
}

async function main() {
  const selected = await listSinglesTests();
  process.stdout.write(`${selected.join("\n")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to list Daytona E2E singles: ${message}`);
    process.exitCode = 1;
  });
}
