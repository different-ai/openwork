import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type VersionInfo = {
  version: string;
  sha256: string;
};

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(root, "..", "..");
const targetDir = resolve(root, "dist");

const serverBin = resolve(root, "..", "server", "dist", "bin", "openwork-server");
const routerRepo = process.env.OPENCODE_ROUTER_DIR?.trim() || resolve(repoRoot, "packages", "opencode-router");
if (!existsSync(resolve(routerRepo, "package.json"))) {
  throw new Error("OpenCodeRouter package not found. Expected packages/opencode-router in the monorepo.");
}
const routerBin = resolve(routerRepo, "dist", "bin", "opencode-router");

const serverPkg = JSON.parse(
  await readFile(resolve(root, "..", "server", "package.json"), "utf8"),
) as { version: string };
const routerPkg = JSON.parse(await readFile(resolve(routerRepo, "package.json"), "utf8")) as { version: string };

await mkdir(targetDir, { recursive: true });
await copyFile(serverBin, resolve(targetDir, "openwork-server"));
await copyFile(routerBin, resolve(targetDir, "opencode-router"));

const sha256 = async (path: string) => {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
};

const versions = {
  "openwork-server": {
    version: serverPkg.version,
    sha256: await sha256(resolve(targetDir, "openwork-server")),
  },
  "opencode-router": {
    version: routerPkg.version,
    sha256: await sha256(resolve(targetDir, "opencode-router")),
  },
} as Record<string, VersionInfo>;

await writeFile(resolve(targetDir, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`, "utf8");
