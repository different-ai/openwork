import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputRoot = resolve(packageRoot, "dist/npm");
  const sourcePackage = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8")
  );

  const publishedPackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    description: sourcePackage.description,
    type: sourcePackage.type,
    bin: sourcePackage.bin,
    repository: sourcePackage.repository,
    homepage: sourcePackage.homepage,
    bugs: sourcePackage.bugs,
    keywords: sourcePackage.keywords,
    license: sourcePackage.license,
    publishConfig: sourcePackage.publishConfig
  };

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(resolve(outputRoot, "bin"), { recursive: true });
  await mkdir(resolve(outputRoot, "dist/bin"), { recursive: true });
  await cp(
    resolve(packageRoot, "bin/openwork-server.mjs"),
    resolve(outputRoot, "bin/openwork-server.mjs")
  );
  await cp(
    resolve(packageRoot, "dist/bin/openwork-server"),
    resolve(outputRoot, "dist/bin/openwork-server")
  );
  await cp(resolve(packageRoot, "README.md"), resolve(outputRoot, "README.md"));
  await writeFile(
    resolve(outputRoot, "package.json"),
    `${JSON.stringify(publishedPackage, null, 2)}\n`
  );

  const args = process.argv.slice(2);
  if (args.includes("--prepare-only")) return;

  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm executable path is unavailable");

  const result = spawnSync(
    process.execPath,
    [pnpmCli, "--config.git-checks=false", "publish", ...args],
    { cwd: outputRoot, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
