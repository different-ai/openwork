import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const major = (version) => /^[~^]?(\d+)\./.exec(version)?.[1];

test("workspace React and React DOM types use the same major", () => {
  let checked = 0;
  for (const parent of ["apps", "packages", "ee/apps", "ee/packages"]) {
    for (const entry of readdirSync(new URL(`${parent}/`, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let manifest;
      try { manifest = JSON.parse(read(`${parent}/${entry.name}/package.json`)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      if (!dependencies["@types/react-dom"]) continue;
      assert.ok(major(dependencies["@types/react"]), `${manifest.name} declares its React types`);
      assert.equal(major(dependencies["@types/react-dom"]), major(dependencies["@types/react"]), manifest.name);
      checked++;
    }
  }
  assert.ok(checked >= 8, "check every workspace that declares React DOM types");
});

test("locked React DOM type snapshots never bind to a different React major", () => {
  const snapshots = [...read("pnpm-lock.yaml").matchAll(/^  '@types\/react-dom@(\d+)\.[^\n]*\(@types\/react@(\d+)\.[^\n]*\)':/gm)];
  assert.ok(snapshots.length >= 2, "check the React 18 and React 19 type graphs");
  for (const [snapshot, dom, react] of snapshots) assert.equal(dom, react, snapshot.trim());
});
