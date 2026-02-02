import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(root, "..", "..");
const outdir = resolve(root, "dist", "sidecars");

const openwrkPkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const openwrkVersion = String(openwrkPkg.version ?? "").trim();
if (!openwrkVersion) {
  throw new Error("openwrk version missing in packages/headless/package.json");
}

const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH
  ? Number(process.env.SOURCE_DATE_EPOCH)
  : null;
const generatedAt = Number.isFinite(sourceDateEpoch)
  ? new Date(sourceDateEpoch * 1000).toISOString()
  : new Date().toISOString();

const serverPkg = JSON.parse(readFileSync(resolve(repoRoot, "packages", "server", "package.json"), "utf8"));
const serverVersion = String(serverPkg.version ?? "").trim();
if (!serverVersion) {
  throw new Error("openwork-server version missing in packages/server/package.json");
}

const owpenbotPkg = JSON.parse(readFileSync(resolve(repoRoot, "packages", "owpenbot", "package.json"), "utf8"));
const owpenbotVersion = String(owpenbotPkg.version ?? "").trim();
if (!owpenbotVersion) {
  throw new Error("owpenbot version missing in packages/owpenbot/package.json");
}

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run("pnpm", ["--filter", "openwork-server", "build:bin:all"], repoRoot);
run("pnpm", ["--filter", "owpenwork", "build:bin:all"], repoRoot);

const targets = [
  { id: "darwin-arm64", bun: "bun-darwin-arm64" },
  { id: "darwin-x64", bun: "bun-darwin-x64" },
  { id: "linux-x64", bun: "bun-linux-x64" },
  { id: "linux-arm64", bun: "bun-linux-arm64" },
  { id: "windows-x64", bun: "bun-windows-x64" },
];

const sha256File = (path) => {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
};

const serverDir = resolve(repoRoot, "packages", "server", "dist", "bin");
const owpenbotDir = resolve(repoRoot, "packages", "owpenbot", "dist", "bin");

mkdirSync(outdir, { recursive: true });

const entries = {
  "openwork-server": { version: serverVersion, targets: {} },
  owpenbot: { version: owpenbotVersion, targets: {} },
};

for (const target of targets) {
  const ext = target.id.startsWith("windows") ? ".exe" : "";
  const serverSrc = join(serverDir, `openwork-server-${target.bun}${ext}`);
  if (!existsSync(serverSrc)) {
    throw new Error(`Missing openwork-server binary at ${serverSrc}`);
  }
  const serverDest = join(outdir, `openwork-server-${target.id}${ext}`);
  copyFileSync(serverSrc, serverDest);

  const owpenbotSrc = join(owpenbotDir, `owpenbot-${target.bun}${ext}`);
  if (!existsSync(owpenbotSrc)) {
    throw new Error(`Missing owpenbot binary at ${owpenbotSrc}`);
  }
  const owpenbotDest = join(outdir, `owpenbot-${target.id}${ext}`);
  copyFileSync(owpenbotSrc, owpenbotDest);

  entries["openwork-server"].targets[target.id] = {
    asset: basename(serverDest),
    sha256: sha256File(serverDest),
    size: statSync(serverDest).size,
  };
  entries.owpenbot.targets[target.id] = {
    asset: basename(owpenbotDest),
    sha256: sha256File(owpenbotDest),
    size: statSync(owpenbotDest).size,
  };
}

const manifest = {
  version: openwrkVersion,
  generatedAt,
  entries,
};

writeFileSync(join(outdir, "openwrk-sidecars.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
