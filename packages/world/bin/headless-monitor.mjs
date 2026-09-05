#!/usr/bin/env node

const [runtimeManifestPath] = process.argv.slice(2);
if (!runtimeManifestPath) process.exit(1);

const { monitorHeadlessRuntime } = await import("../src/headless-web.ts");

await monitorHeadlessRuntime(runtimeManifestPath);
