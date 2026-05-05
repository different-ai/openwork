import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const bunRuntime = (globalThis as typeof globalThis & {
  Bun?: {
    build?: (...args: any[]) => Promise<any>;
    argv?: string[];
  };
}).Bun;

if (!bunRuntime?.build || !bunRuntime.argv) {
  console.error("This script must be run with Bun.");
  process.exit(1);
}

const bun = bunRuntime as { build: (...args: any[]) => Promise<any>; argv: string[] };

type BuildOptions = {
  targets: string[];
  outdir: string;
  filename: string;
};

function readArgs(argv: string[]): BuildOptions {
  const options: BuildOptions = {
    targets: [],
    outdir: resolve("dist", "bin"),
    filename: "openwork-server",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;

    if (value === "--target") {
      const next = argv[index + 1];
      if (next) {
        options.targets.push(next);
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--target=")) {
      const next = value.slice("--target=".length).trim();
      if (next) options.targets.push(next);
      continue;
    }

    if (value === "--outdir") {
      const next = argv[index + 1];
      if (next) {
        options.outdir = resolve(next);
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--outdir=")) {
      const next = value.slice("--outdir=".length).trim();
      if (next) options.outdir = resolve(next);
      continue;
    }

    if (value === "--filename") {
      const next = argv[index + 1];
      if (next) {
        options.filename = next;
        index += 1;
      }
      continue;
    }

    if (value.startsWith("--filename=")) {
      const next = value.slice("--filename=".length).trim();
      if (next) options.filename = next;
    }
  }

  return options;
}

function outputName(filename: string, target?: string) {
  const needsExe = target ? target.includes("windows") : process.platform === "win32";
  const suffix = target ? `-${target}` : "";
  const ext = needsExe ? ".exe" : "";
  return `${filename}${suffix}${ext}`;
}

function targetMatchesHost(target?: string): boolean {
  if (!target) return true;
  const isWindowsTarget = target.includes("windows");
  const isLinuxTarget = target.includes("linux");
  const isDarwinTarget = target.includes("darwin");
  if (process.platform === "win32") return isWindowsTarget;
  if (process.platform === "linux") return isLinuxTarget;
  if (process.platform === "darwin") return isDarwinTarget;
  return false;
}

function readPackageVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

function verifyBuiltBinary(outfile: string, expectedVersion: string | null) {
  if (!expectedVersion) return;
  const result = spawnSync(outfile, ["--version"], { encoding: "utf8" });
  const stdout = (result.stdout ?? "").trim();
  if (result.status === 0 && stdout === expectedVersion) return;
  console.error(
    [
      `openwork-server build verification failed for ${outfile}.`,
      `  expected --version: ${expectedVersion}`,
      `  actual exit status: ${result.status ?? "unknown"}`,
      `  actual stdout:      ${stdout || "(empty)"}`,
      "  the binary may be a bare Bun runtime instead of a compiled openwork-server.",
    ].join("\n"),
  );
  process.exit(1);
}

async function buildOnce(entrypoint: string, outdir: string, filename: string, target?: string) {
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, outputName(filename, target));

  const args = ["build", entrypoint, "--compile", "--outfile", outfile];
  if (target) {
    args.push("--target", target);
  }

  const result = spawnSync("bun", args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (targetMatchesHost(target)) {
    verifyBuiltBinary(outfile, readPackageVersion());
  }
}

const options = readArgs(bun.argv.slice(2));
const entrypoint = resolve("src", "cli.ts");
const targets = options.targets.length ? options.targets : [undefined];

for (const target of targets) {
  await buildOnce(entrypoint, options.outdir, options.filename, target);
}
