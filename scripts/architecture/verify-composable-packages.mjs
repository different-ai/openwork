#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
const packageNames = [
  "@openwork/extension-contracts",
  "@openwork/contribution-registry",
  "@openwork/extension-catalog",
  "@openwork/session-contracts",
  "@openwork/session-groups",
  "@openwork/workspace-portability",
  "@openwork/markdown",
];
const exportSpecifiers = [
  "@openwork/extension-contracts",
  "@openwork/extension-contracts/schemas",
  "@openwork/extension-contracts/selectors",
  "@openwork/extension-contracts/validation",
  "@openwork/contribution-registry",
  "@openwork/extension-catalog",
  "@openwork/extension-catalog/den-marketplace",
  "@openwork/session-contracts",
  "@openwork/session-contracts/schemas",
  "@openwork/session-contracts/types",
  "@openwork/session-contracts/validation",
  "@openwork/session-groups",
  "@openwork/workspace-portability",
  "@openwork/markdown",
  "@openwork/markdown/browser",
  "@openwork/markdown/text-highlights",
];
const assetSpecifiers = ["@openwork/markdown/styles.css"];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  }
}

const proofRoot = mkdtempSync(join(tmpdir(), "openwork-composable-packages-"));
const tarballRoot = join(proofRoot, "tarballs");
const consumerRoot = join(proofRoot, "consumer");

try {
  mkdirSync(tarballRoot, { recursive: true });
  const packageTarballs = new Map();
  for (const packageName of packageNames) {
    run("pnpm", ["--filter", packageName, "test"], root);
    run("pnpm", ["--filter", packageName, "typecheck"], root);
    run("pnpm", ["--filter", packageName, "build"], root);
    const before = new Set(readdirSync(tarballRoot));
    run("pnpm", ["--filter", packageName, "pack", "--pack-destination", tarballRoot], root);
    const created = readdirSync(tarballRoot).filter((path) => !before.has(path));
    assert.equal(created.length, 1, `expected one tarball for ${packageName}`);
    packageTarballs.set(packageName, join(tarballRoot, created[0]));
  }

  const dependencies = Object.fromEntries(
    packageNames.map((packageName) => [packageName, `file:${packageTarballs.get(packageName)}`]),
  );

  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "openwork-composable-package-proof",
        private: true,
        type: "module",
        dependencies,
        pnpm: { overrides: dependencies },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  run("pnpm", ["install", "--ignore-scripts"], consumerRoot);

  const requireFromConsumer = createRequire(join(consumerRoot, "verify.cjs"));
  const importedModules = new Map();
  for (const specifier of exportSpecifiers) {
    importedModules.set(specifier, await import(pathToFileURL(requireFromConsumer.resolve(specifier)).href));
  }
  for (const specifier of assetSpecifiers) {
    const asset = readFileSync(requireFromConsumer.resolve(specifier), "utf8");
    assert.match(asset, /@source\s+["']\.\/src["']/, `${specifier} must register its package source`);
  }

  assert.equal(globalThis.document, undefined, "Node consumer proof must run without a DOM");
  const markdownModule = importedModules.get("@openwork/markdown");
  const headlessMarkdown = markdownModule.createMarkdownRenderingKernel({
    sanitizeHtml: (html) => html,
    isHighlightLanguageSupported: () => false,
    highlightCode: () => Promise.reject(new Error("unused in synchronous proof")),
  });
  assert.match(
    headlessMarkdown.renderSync("# Packed consumer", "document-preview"),
    /<h1[^>]*>Packed consumer<\/h1>/,
    "the packed root must render without browser globals",
  );

  process.stdout.write(
    `${JSON.stringify({ ok: true, packages: packageNames, exports: exportSpecifiers, assets: assetSpecifiers }, null, 2)}\n`,
  );
} finally {
  rmSync(proofRoot, { recursive: true, force: true });
}
