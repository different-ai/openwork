#!/usr/bin/env node

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseElectronUpdaterYaml } from "./verify-updater-endpoint.mjs";

function parseArgs(argv) {
  const options = {
    inputDir: "",
    outputDir: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-dir") {
      options.inputDir = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--output-dir") {
      options.outputDir = argv[index + 1] || "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.inputDir) throw new Error("Missing --input-dir.");
  if (!options.outputDir) throw new Error("Missing --output-dir.");
  return options;
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function outputNameForMetadataFile(filePath) {
  const name = path.basename(filePath);
  const match = name.match(/(latest(?:-[A-Za-z0-9]+)*\.yml)$/);
  return match?.[1] ?? null;
}

function pickPrimaryFile(files) {
  return (
    files.find((file) => String(file.url || "").endsWith(".zip")) ||
    files.find((file) => String(file.url || "").endsWith(".exe")) ||
    files.find((file) => String(file.url || "").endsWith(".AppImage")) ||
    files[0]
  );
}

function mergeElectronUpdaterManifests(manifests, outputName = "latest.yml") {
  if (!manifests.length) {
    throw new Error(`No updater metadata found for ${outputName}.`);
  }

  const version = manifests[0].version;
  const filesByUrl = new Map();
  let releaseDate = manifests[0].releaseDate;

  for (const manifest of manifests) {
    if (manifest.version !== version) {
      throw new Error(`Cannot merge ${outputName}: versions differ (${version} vs ${manifest.version}).`);
    }
    if (manifest.releaseDate && (!releaseDate || Date.parse(manifest.releaseDate) > Date.parse(releaseDate))) {
      releaseDate = manifest.releaseDate;
    }
    for (const file of manifest.files || []) {
      if (!file?.url) continue;
      filesByUrl.set(file.url, { ...file });
    }
  }

  const files = Array.from(filesByUrl.values()).sort((left, right) => String(left.url).localeCompare(String(right.url)));
  const primary = pickPrimaryFile(files);
  if (!primary) {
    throw new Error(`Cannot merge ${outputName}: no files found.`);
  }

  return {
    version,
    files,
    path: primary.url,
    sha512: primary.sha512,
    releaseDate,
  };
}

function yamlScalar(value) {
  const text = String(value ?? "");
  if (/^\d+$/.test(text)) return text;
  if (/^[A-Za-z0-9_./+=:-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "''")}'`;
}

function serializeElectronUpdaterYaml(manifest) {
  const lines = [`version: ${yamlScalar(manifest.version)}`, "files:"];
  for (const file of manifest.files) {
    lines.push(`  - url: ${yamlScalar(file.url)}`);
    lines.push(`    sha512: ${yamlScalar(file.sha512)}`);
    if (file.size !== undefined) lines.push(`    size: ${yamlScalar(file.size)}`);
    if (file.blockMapSize !== undefined) lines.push(`    blockMapSize: ${yamlScalar(file.blockMapSize)}`);
  }
  lines.push(`path: ${yamlScalar(manifest.path)}`);
  lines.push(`sha512: ${yamlScalar(manifest.sha512)}`);
  lines.push(`releaseDate: '${String(manifest.releaseDate || "").replaceAll("'", "''")}'`);
  return `${lines.join("\n")}\n`;
}

async function consolidateElectronUpdaterYml({ inputDir, outputDir }) {
  const files = await listFiles(inputDir);
  const groups = new Map();

  for (const file of files) {
    const outputName = outputNameForMetadataFile(file);
    if (!outputName) continue;
    const manifest = parseElectronUpdaterYaml(await readFile(file, "utf8"));
    const group = groups.get(outputName) || [];
    group.push({ file, manifest });
    groups.set(outputName, group);
  }

  if (!groups.size) {
    throw new Error(`No latest*.yml files found in ${inputDir}.`);
  }

  await mkdir(outputDir, { recursive: true });
  const outputs = [];
  for (const [outputName, entries] of groups) {
    const outputPath = path.join(outputDir, outputName);
    if (entries.length === 1) {
      await copyFile(entries[0].file, outputPath);
    } else {
      const manifest = mergeElectronUpdaterManifests(
        entries.map((entry) => entry.manifest),
        outputName,
      );
      await writeFile(outputPath, serializeElectronUpdaterYaml(manifest), "utf8");
    }
    outputs.push(outputPath);
  }
  return outputs.sort();
}

async function main() {
  const outputs = await consolidateElectronUpdaterYml(parseArgs(process.argv));
  for (const output of outputs) {
    console.log(`Wrote ${output}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

export { consolidateElectronUpdaterYml, mergeElectronUpdaterManifests, outputNameForMetadataFile, serializeElectronUpdaterYaml };
