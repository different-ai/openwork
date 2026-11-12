import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * Den web shows no sessions. What other devices can do on a computer is on
 * the computer's own record, and the only remote-access call left is the
 * organization's limit. This reads the app's source to keep it that way.
 */
const appRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const componentsRoot = fileURLToPath(new URL("../../../../../components/", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === "node_modules" || entry === ".next") return [];
    const path = `${directory}${entry}`;
    if (statSync(path).isDirectory()) return sources(`${path}/`);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const files = [...sources(appRoot), ...sources(componentsRoot)];
const using = (pattern: RegExp) => files.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => file.replace(appRoot, "app/").replace(componentsRoot, "components/"));

test("nothing in Den web asks Den for a member's sessions or talks to one", () => {
  assert.ok(files.length > 200, `expected to read the whole app, found ${files.length} files`);
  assert.deepEqual(using(/\/v1\/sessions\b/), []);
  assert.deepEqual(using(/\/v1\/remote-sessions\b/), []);
  // The one remote-access route left is the organization's limit, called from one place.
  assert.deepEqual(using(/\/v1\/org\/remote-session-settings\b/), ["app/(den)/dashboard/_features/computers/remote-access-data.ts"]);
});

test("the Sessions page, its panel and its entry are gone", () => {
  assert.deepEqual(files.filter((file) => /\/my-sessions\/|\/_features\/sessions\//.test(file)), []);
  assert.deepEqual(using(/my-sessions|MySessions|getMySessionsRoute|mySessionsAvailable|dashboard-nav-my-sessions/), []);
  assert.deepEqual(using(/["'`]My Sessions["'`]/), []);
});
