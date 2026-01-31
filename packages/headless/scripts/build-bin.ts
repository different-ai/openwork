import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type VersionInfo = {
  version: string;
  sha256: string;
};

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetDir = resolve(root, "dist");

const serverBin = resolve(root, "..", "server", "dist", "bin", "openwork-server");
const owpenbotBin = resolve(root, "..", "owpenbot", "dist", "bin", "owpenbot");

const serverPkg = JSON.parse(
  await readFile(resolve(root, "..", "server", "package.json"), "utf8"),
) as { version: string };
const owpenbotPkg = JSON.parse(
  await readFile(resolve(root, "..", "owpenbot", "package.json"), "utf8"),
) as { version: string };

await mkdir(targetDir, { recursive: true });
await copyFile(serverBin, resolve(targetDir, "openwork-server"));
await copyFile(owpenbotBin, resolve(targetDir, "owpenbot"));

const sha256 = async (path: string) => {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
};

const versions = {
  "openwork-server": {
    version: serverPkg.version,
    sha256: await sha256(resolve(targetDir, "openwork-server")),
  },
  owpenbot: {
    version: owpenbotPkg.version,
    sha256: await sha256(resolve(targetDir, "owpenbot")),
  },
} as Record<string, VersionInfo>;

await writeFile(resolve(targetDir, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`, "utf8");
