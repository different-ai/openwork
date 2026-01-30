import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(root, "..", "server", "dist", "bin", "openwork-server");
const targetDir = resolve(root, "dist");
const target = resolve(targetDir, "openwork-server");

await mkdir(targetDir, { recursive: true });
await copyFile(source, target);
