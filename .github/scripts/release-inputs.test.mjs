import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (name) => readFileSync(new URL("../../" + name, import.meta.url), "utf8");
const workflow = (name) => read(`.github/workflows/${name}.yml`);

test("release workflows and their local actions use immutable external action revisions", () => {
  const pending = ["alpha-macos-aarch64", "release-macos-aarch64", "managed-stable-release", "publish-ee-images",
    "publish-opencode-plugin", "production-deploy", "aur-validate", "npm-release-smoke-check", "daytona-eval-image"]
    .map((name) => `.github/workflows/${name}.yml`);
  const seen = new Set();
  for (const file of pending) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, ref] of read(file).matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm)) {
      if (ref.startsWith("./")) {
        const path = ref.slice(2);
        pending.push(path.endsWith(".yml") ? path : path + "/action.yml");
      } else {
        assert.match(ref, /@[a-f\d]{40}$/, file + " uses " + ref);
      }
    }
  }
  assert.ok(seen.has(".github/actions/windows-signing/action.yml"));
  assert.ok(seen.has(".github/actions/setup-tests/action.yml"));
});

test("contributor and alternate-ref workflows cap the runtime cache token", () => {
  for (const name of ["pr-proof", "packaged-smoke", "aur-validate", "freestyle-world-check",
    "contributor-pr", "contributor-pr-test", "contributor-screen"]) {
    const content = workflow(name);
    assert.match(content, /^cache-mode: (read|none)$/m, name);
    assert.doesNotMatch(content, /^\s+cache-mode: write/m, name);
  }
});

test("desktop release stores restore only their channel, architecture and lockfile", () => {
  for (const [name, channel] of [["release-macos-aarch64", "stable"], ["alpha-macos-aarch64", "alpha"]]) {
    const stores = workflow(name).split(/^\s*- name: /m).filter((step) => step.startsWith("Cache pnpm store\n"));
    assert.equal(stores.length, 2);
    for (const store of stores) {
      assert.ok(store.includes("key: " + channel + "-release-${{ runner.os }}-${{ runner.arch }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}"));
      assert.doesNotMatch(store, /restore-keys:/);
    }
  }
});
