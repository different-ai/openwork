#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const workspaceRoots = ["apps", "packages", "ee/apps", "ee/packages"];
const allowedLayers = new Set(["contract", "kernel", "domain", "adapter", "presentation", "host", "tool"]);
const allowedRealms = new Set([
  "neutral",
  "browser",
  "worker",
  "node",
  "bun",
  "deno",
  "electron-main",
  "electron-renderer",
]);
const allowedStabilities = new Set(["experimental", "candidate", "stable", "deprecated"]);
const allowedDependencies = {
  contract: new Set(["contract"]),
  kernel: new Set(["contract", "kernel"]),
  domain: new Set(["contract", "kernel", "domain"]),
  adapter: new Set(["contract", "kernel", "domain", "adapter"]),
  presentation: new Set(["contract", "kernel", "domain", "presentation"]),
  host: new Set(["contract", "kernel", "domain", "adapter", "presentation", "host"]),
  tool: new Set(["contract", "kernel", "domain", "adapter", "presentation", "tool"]),
};
const realmCompatibility = {
  neutral: new Set(["neutral"]),
  browser: new Set(["neutral", "browser"]),
  worker: new Set(["neutral", "worker"]),
  node: new Set(["neutral", "node"]),
  bun: new Set(["neutral", "node", "bun"]),
  deno: new Set(["neutral", "deno"]),
  "electron-main": new Set(["neutral", "node", "electron-main"]),
  "electron-renderer": new Set(["neutral", "browser", "electron-renderer"]),
};
const requiredReadmeHeadings = [
  "Purpose",
  "Supported realms",
  "Authority",
  "Public exports",
  "Boundaries",
];
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const browserOnlyImports = [
  "react",
  "react-dom",
  "preact",
  "solid-js",
  "@solidjs/",
  "vue",
  "svelte",
  "dompurify",
];
const browserOnlyExtensions = [".css", ".scss", ".sass", ".less", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"];
const explicitAssetExtensions = new Set([...browserOnlyExtensions, ".wasm"]);
const nodeBuiltins = new Set(
  builtinModules.flatMap((name) => {
    const bareName = name.replace(/^node:/, "");
    return [name, bareName, bareName.split("/")[0]];
  }),
);

const errors = [];

function report(manifestPath, message) {
  errors.push(`${relative(root, manifestPath)}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    report(path, `cannot parse JSON (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

function listWorkspaceManifests() {
  const paths = [];
  for (const workspaceRoot of workspaceRoots) {
    const absoluteRoot = resolve(root, workspaceRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = resolve(absoluteRoot, entry.name, "package.json");
      if (existsSync(manifestPath)) paths.push(manifestPath);
    }
  }
  return paths.sort();
}

function listSourceFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (sourceExtensions.has(extension)) files.push(path);
  }
  return files;
}

function importedSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function exportTargets(value, manifestPath, exportName) {
  if (typeof value === "string") {
    if (!value.startsWith("./")) {
      report(manifestPath, `exports[${JSON.stringify(exportName)}] asset target must be package-relative`);
      return [];
    }
    const extension = value.slice(value.lastIndexOf("."));
    if (!explicitAssetExtensions.has(extension)) {
      report(
        manifestPath,
        `exports[${JSON.stringify(exportName)}] string target must be an explicit static asset`,
      );
      return [];
    }
    return [{ condition: "asset", target: value }];
  }

  if (!isRecord(value)) {
    report(manifestPath, `exports[${JSON.stringify(exportName)}] must be a condition object or static asset`);
    return [];
  }

  const targets = [];
  for (const condition of ["types", "development", "default"]) {
    const target = value[condition];
    if (typeof target !== "string") {
      report(manifestPath, `exports[${JSON.stringify(exportName)}].${condition} must be a string`);
      continue;
    }
    if (!target.startsWith("./")) {
      report(manifestPath, `exports[${JSON.stringify(exportName)}].${condition} must be package-relative`);
      continue;
    }
    targets.push({ condition, target });
  }
  return targets;
}

function validateMetadata(workspace) {
  const { manifest, manifestPath, contract } = workspace;
  if (!isRecord(contract)) {
    report(manifestPath, "openwork.packageContract must be an object");
    return;
  }

  const expectedKeys = ["schemaVersion", "capability", "layer", "realms", "stability"];
  for (const key of expectedKeys) {
    if (!(key in contract)) report(manifestPath, `openwork.packageContract.${key} is required`);
  }
  for (const key of Object.keys(contract)) {
    if (!expectedKeys.includes(key)) report(manifestPath, `openwork.packageContract.${key} is not a schema v1 field`);
  }

  if (contract.schemaVersion !== 1) {
    report(manifestPath, "openwork.packageContract.schemaVersion must equal 1");
  }
  if (typeof contract.capability !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(contract.capability)) {
    report(manifestPath, "openwork.packageContract.capability must be a non-empty kebab-case identifier");
  }
  if (!allowedLayers.has(contract.layer)) {
    report(manifestPath, `openwork.packageContract.layer must be one of ${[...allowedLayers].join(", ")}`);
  }
  if (!Array.isArray(contract.realms) || contract.realms.length === 0) {
    report(manifestPath, "openwork.packageContract.realms must be a non-empty array");
  } else {
    const uniqueRealms = new Set(contract.realms);
    if (uniqueRealms.size !== contract.realms.length) {
      report(manifestPath, "openwork.packageContract.realms must not contain duplicates");
    }
    for (const realm of contract.realms) {
      if (!allowedRealms.has(realm)) {
        report(manifestPath, `unsupported package realm ${JSON.stringify(realm)}`);
      }
    }
    if (uniqueRealms.has("neutral") && uniqueRealms.size !== 1) {
      report(manifestPath, 'the "neutral" realm is exclusive; use only concrete realms for a realm-specific package');
    }
  }
  if (!allowedStabilities.has(contract.stability)) {
    report(manifestPath, `openwork.packageContract.stability must be one of ${[...allowedStabilities].join(", ")}`);
  }

  const realms = new Set(Array.isArray(contract.realms) ? contract.realms : []);
  if (["contract", "kernel", "domain"].includes(contract.layer) && !(realms.size === 1 && realms.has("neutral"))) {
    report(manifestPath, `${contract.layer} packages must be realm-neutral`);
  }
  if (contract.layer === "presentation" && !realms.has("browser") && !realms.has("electron-renderer")) {
    report(manifestPath, "presentation packages must declare a browser-capable realm");
  }
  if ((contract.layer === "adapter" || contract.layer === "host") && realms.has("neutral")) {
    report(manifestPath, `${contract.layer} packages must declare their concrete authority realm`);
  }
  if (contract.layer === "tool" && !realms.has("node") && !realms.has("bun")) {
    report(manifestPath, "tool packages must declare the node or bun realm");
  }

  const packageDirectory = dirname(manifestPath);
  const packageLocation = relative(root, packageDirectory).split(sep).join("/");
  if (!/^packages\/[^/]+$/.test(packageLocation)) {
    report(manifestPath, "governed reusable packages must live directly under packages/, never apps/ or ee/");
  }

  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@openwork/")) {
    report(manifestPath, "governed packages must use the @openwork scope");
  }
  if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
    report(manifestPath, "version is required");
  }
  if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) {
    report(manifestPath, "description is required");
  }
  if (manifest.license !== "MIT") report(manifestPath, 'license must explicitly be "MIT"');
  if (manifest.type !== "module") report(manifestPath, 'type must explicitly be "module"');
  if (!(typeof manifest.sideEffects === "boolean" || Array.isArray(manifest.sideEffects))) {
    report(manifestPath, "sideEffects must be explicitly declared");
  }

  if (!Array.isArray(manifest.files)) {
    report(manifestPath, "files must be an explicit array");
  } else {
    for (const requiredFile of ["dist", "src", "README.md"]) {
      if (!manifest.files.includes(requiredFile)) report(manifestPath, `files must include ${JSON.stringify(requiredFile)}`);
    }
  }

  for (const scriptName of ["build", "test", "typecheck"]) {
    if (typeof manifest.scripts?.[scriptName] !== "string" || manifest.scripts[scriptName].trim().length === 0) {
      report(manifestPath, `scripts.${scriptName} is required`);
    }
  }

  if (!isRecord(manifest.exports) || !("." in manifest.exports)) {
    report(manifestPath, 'exports must be an explicit subpath map containing "."');
  } else {
    for (const [exportName, value] of Object.entries(manifest.exports)) {
      if (!exportName.startsWith(".") || exportName.includes("*")) {
        report(manifestPath, `export key ${JSON.stringify(exportName)} must be an explicit package subpath`);
      }
      for (const { condition, target } of exportTargets(value, manifestPath, exportName)) {
        if (condition === "asset") {
          if (exportName === ".") {
            report(manifestPath, "the root export cannot be a static asset");
          }
          if (!existsSync(resolve(packageDirectory, target))) {
            report(manifestPath, `exports[${JSON.stringify(exportName)}] asset does not exist: ${target}`);
          }
          const topLevelPath = target.slice(2).split("/")[0];
          if (!manifest.files?.includes(topLevelPath)) {
            report(
              manifestPath,
              `files must include exported asset path ${JSON.stringify(topLevelPath)}`,
            );
          }
          if (
            target.endsWith(".css") &&
            !(Array.isArray(manifest.sideEffects) && manifest.sideEffects.includes(target))
          ) {
            report(
              manifestPath,
              `exported stylesheet ${JSON.stringify(target)} must be listed in sideEffects`,
            );
          }
          continue;
        }
        const expectedDirectory = condition === "default" ? "./dist/" : "./src/";
        if (!target.startsWith(expectedDirectory)) {
          report(manifestPath, `exports[${JSON.stringify(exportName)}].${condition} must target ${expectedDirectory}`);
        }
        if (condition !== "default" && !existsSync(resolve(packageDirectory, target))) {
          report(manifestPath, `exports[${JSON.stringify(exportName)}].${condition} target does not exist: ${target}`);
        }
      }
    }
  }

  const readmePath = resolve(packageDirectory, "README.md");
  if (!existsSync(readmePath)) {
    report(manifestPath, "README.md is required");
  } else {
    const readme = readFileSync(readmePath, "utf8");
    if (!readme.includes(`# \`${manifest.name}\``) && !readme.includes(`# ${manifest.name}`)) {
      report(manifestPath, "README.md must start with a package-name heading");
    }
    for (const heading of requiredReadmeHeadings) {
      if (!new RegExp(`^## ${heading}$`, "m").test(readme)) {
        report(manifestPath, `README.md must include a "## ${heading}" section`);
      }
    }
    if (isRecord(manifest.exports)) {
      for (const exportName of Object.keys(manifest.exports)) {
        const specifier = exportName === "." ? manifest.name : `${manifest.name}${exportName.slice(1)}`;
        if (!readme.includes(`\`${specifier}\``)) {
          report(manifestPath, `README.md Public exports must name ${specifier}`);
        }
      }
    }
  }
}

function validateSourceBoundaries(workspace, workspacesByName) {
  const { manifest, manifestPath, contract } = workspace;
  const neutral = Array.isArray(contract.realms) && contract.realms.includes("neutral");

  const packageDirectory = dirname(manifestPath);
  for (const sourcePath of listSourceFiles(resolve(packageDirectory, "src"))) {
    const source = readFileSync(sourcePath, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      if (neutral) {
        const bareRoot = specifier.replace(/^node:/, "").split("/")[0];
        if (specifier.startsWith("node:") || nodeBuiltins.has(specifier) || nodeBuiltins.has(bareRoot)) {
          report(sourcePath, `neutral package imports Node runtime module ${JSON.stringify(specifier)}`);
        }
        if (
          browserOnlyImports.some((name) => specifier === name || (name.endsWith("/") ? specifier.startsWith(name) : specifier.startsWith(`${name}/`))) ||
          browserOnlyExtensions.some((extension) => specifier.endsWith(extension))
        ) {
          report(sourcePath, `neutral package imports browser-only module or asset ${JSON.stringify(specifier)}`);
        }
      }

      const importedWorkspace = workspacesByName.get(specifier) ?? workspacesByName.get(
        [...workspacesByName.keys()].find((name) => specifier.startsWith(`${name}/`)),
      );
      if (importedWorkspace) {
        const importedLocation = relative(root, dirname(importedWorkspace.manifestPath)).split(sep).join("/");
        if (importedLocation.startsWith("apps/") || importedLocation.startsWith("ee/")) {
          report(sourcePath, `governed package imports host or enterprise workspace ${JSON.stringify(specifier)}`);
        }
      }

      if (specifier.startsWith(".")) {
        const target = resolve(dirname(sourcePath), specifier);
        const relativeTarget = relative(packageDirectory, target);
        if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
          report(sourcePath, `relative import escapes the package boundary: ${JSON.stringify(specifier)}`);
        }
      }
    }

    if (neutral) {
      const forbiddenGlobals = source.match(/\b(?:window|document|navigator|localStorage|sessionStorage|HTMLElement|customElements|process|Buffer|__dirname|__filename)\b/g) ?? [];
      for (const name of new Set(forbiddenGlobals)) {
        report(sourcePath, `neutral package references realm-specific global ${JSON.stringify(name)}`);
      }
    }
  }
}

function validateDependencyDirection(workspace, governedByName, workspacesByName) {
  const { manifest, manifestPath, contract } = workspace;
  const dependencySections = ["dependencies", "optionalDependencies", "peerDependencies"];
  for (const section of dependencySections) {
    for (const dependencyName of Object.keys(manifest[section] ?? {})) {
      const targetWorkspace = workspacesByName.get(dependencyName);
      if (!targetWorkspace) continue;
      const target = governedByName.get(dependencyName);
      if (!target) {
        report(manifestPath, `${section}.${dependencyName} points to an ungoverned workspace package`);
        continue;
      }
      if (!allowedDependencies[contract.layer]?.has(target.contract.layer)) {
        report(
          manifestPath,
          `${contract.layer} package cannot depend on ${target.contract.layer} package ${dependencyName}`,
        );
      }

      const sourceRealms = Array.isArray(contract.realms) ? contract.realms : [];
      const targetRealms = Array.isArray(target.contract.realms) ? target.contract.realms : [];
      const compatible = sourceRealms.some((sourceRealm) =>
        targetRealms.some((targetRealm) => realmCompatibility[sourceRealm]?.has(targetRealm)),
      );
      if (!compatible) {
        report(
          manifestPath,
          `${dependencyName} realms [${targetRealms.join(", ")}] are incompatible with [${sourceRealms.join(", ")}]`,
        );
      }
    }
  }
}

const workspaces = listWorkspaceManifests()
  .map((manifestPath) => ({ manifestPath, manifest: readJson(manifestPath) }))
  .filter((workspace) => workspace.manifest !== undefined);
const workspacesByName = new Map(
  workspaces
    .filter(({ manifest }) => typeof manifest.name === "string")
    .map((workspace) => [workspace.manifest.name, workspace]),
);
const governed = workspaces
  .filter(({ manifest }) => manifest.openwork?.packageContract !== undefined)
  .map((workspace) => ({ ...workspace, contract: workspace.manifest.openwork.packageContract }));
const governedByName = new Map(governed.map((workspace) => [workspace.manifest.name, workspace]));

if (governed.length === 0) errors.push("no packages declare openwork.packageContract");

const capabilities = new Map();
for (const workspace of governed) {
  validateMetadata(workspace);
  validateSourceBoundaries(workspace, workspacesByName);
  const capability = workspace.contract?.capability;
  if (typeof capability === "string") {
    const previous = capabilities.get(capability);
    if (previous) {
      report(workspace.manifestPath, `capability ${JSON.stringify(capability)} is already owned by ${previous}`);
    } else {
      capabilities.set(capability, workspace.manifest.name);
    }
  }
}
for (const workspace of governed) {
  validateDependencyDirection(workspace, governedByName, workspacesByName);
}

if (errors.length > 0) {
  process.stderr.write(`Package contract verification failed with ${errors.length} error(s):\n`);
  for (const error of errors.sort()) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        schemaVersion: 1,
        packages: governed.map(({ manifest, contract }) => ({
          name: manifest.name,
          capability: contract.capability,
          layer: contract.layer,
          realms: contract.realms,
          stability: contract.stability,
        })),
      },
      null,
      2,
    )}\n`,
  );
}
