import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isContractInput } from "./den-contract-hook.mjs";

const stamp = "packages/sdk/src/gen/.contract-cache.json";

function digest(root, paths) {
  const hash = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path).update("\0");
    hash.update(existsSync(join(root, path)) ? readFileSync(join(root, path)) : "deleted").update("\0");
  }
  return hash.digest("hex");
}

export function contractInputDigest(root) {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(isContractInput);
  return digest(root, paths);
}

function outputDigest(root) {
  function files(path) {
    return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      return child === stamp ? [] : entry.isDirectory() ? files(child) : [child];
    });
  }
  return digest(root, ["packages/docs/openapi.json", ...files("packages/sdk/src/gen")]);
}

export function contractIsCurrent(root, input = contractInputDigest(root)) {
  try {
    const saved = JSON.parse(readFileSync(join(root, stamp), "utf8"));
    return saved.input === input && saved.output === outputDigest(root);
  } catch {
    return false;
  }
}

export function invalidateContract(root) {
  rmSync(join(root, stamp), { force: true });
}

export function recordContract(root, input) {
  if (contractInputDigest(root) !== input) throw new Error("Contract inputs changed during generation; run pnpm den:contract again.");
  writeFileSync(join(root, stamp), `${JSON.stringify({ input, output: outputDigest(root) })}\n`);
}
