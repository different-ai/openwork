import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import solidPlugin from "../node_modules/@opentui/solid/scripts/solid-plugin";

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
    filename: "openwork",
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

function defaultTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  return `bun-${os}-${process.arch}`;
}

async function buildOnce(entrypoint: string, outdir: string, filename: string, target?: string) {
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, outputName(filename, target));
  const define: Record<string, string> = {};
  const pkgPath = resolve("package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      define.__OPENWORK_ORCHESTRATOR_VERSION__ = `\"${pkg.version.trim()}\"`;
    }
  } catch {
    // ignore
  }

  const resolvedTarget = target ?? defaultTarget();
  const result = await bun.build({
    tsconfig: "./tsconfig.json",
    plugins: [solidPlugin],
    entrypoints: [entrypoint],
    define,
    compile: {
      target: resolvedTarget,
      outfile,
    },
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

const options = readArgs(bun.argv.slice(2));
const entrypoint = resolve("src", "cli.ts");
const targets = options.targets.length ? options.targets : [undefined];

for (const target of targets) {
  await buildOnce(entrypoint, options.outdir, options.filename, target);
}
