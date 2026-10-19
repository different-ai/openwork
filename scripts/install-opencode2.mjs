#!/usr/bin/env node
// Installs the pinned OpenCode engine (constants.json `opencodeV2Version`) as
// `<outdir>/opencode2`, from the per-platform npm tarball whose sha512
// integrity apps/server/src/opencode-v2-artifacts.json records. Shared by the
// Cloud and self-host images and CI so they all run the verified binary.
//
//   node scripts/install-opencode2.mjs --outdir <dir> [--target <rust target triple>]
//
// `--target` defaults to this host, e.g. x86_64-unknown-linux-gnu for an
// amd64 Linux image built on any machine.
import { resolve } from "node:path";
import { prepareOpencodeV2 } from "../apps/desktop/scripts/prepare-opencode-v2.mjs";

function readArg(name) {
  const args = process.argv.slice(2);
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function hostTarget() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  const os = process.platform === "darwin" ? "apple-darwin"
    : process.platform === "linux" ? "unknown-linux-gnu"
      : process.platform === "win32" ? "pc-windows-msvc" : null;
  if (!arch || !os) throw new Error(`Unsupported host ${process.platform}-${process.arch}; pass --target.`);
  return `${arch}-${os}`;
}

const outdir = readArg("--outdir");
if (!outdir) {
  console.error("Usage: node scripts/install-opencode2.mjs --outdir <dir> [--target <rust target triple>]");
  process.exit(1);
}
const binary = await prepareOpencodeV2(resolve(outdir), readArg("--target") ?? hostTarget());
console.log(binary);
