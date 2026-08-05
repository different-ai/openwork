// Copies the self-contained micx-bootstrap CLI into the landing app's
// public dir so it can be served statically at /micx-bootstrap.mjs.
//
// install.sh downloads this file and installs it as the `micx-bootstrap`
// command, so the installer never depends on npm/npx or a pinned GitHub ref —
// it always matches the deployed landing build.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "..", "..", "..", "packages", "micx-bootstrap", "bin", "micx.mjs");
const targetDir = resolve(here, "..", "public");
const target = join(targetDir, "micx-bootstrap.mjs");

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`[copy-bootstrap-cli] ${source} -> ${target}`);
