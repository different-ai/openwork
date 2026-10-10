import { build } from "esbuild";
import { readFile, readdir, writeFile, copyFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outfile: "dist/index.cjs",
  metafile: true,
  logLevel: "info",
});

// Carry the actual bundled dependency notices into the packaged desktop.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let directory = dirname(resolve(root, input));
  for (;;) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(resolve(directory, "package.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (manifest?.name && manifest?.version) {
      const key = `${manifest.name}@${manifest.version}`;
      if (!packages.has(key)) {
        const files = (await readdir(directory))
          .filter((file) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file))
          .sort();
        const notices = await Promise.all(
          files.map(
            async (file) =>
              `${file}\n${await readFile(resolve(directory, file), "utf8")}`,
          ),
        );
        if (!files.length) {
          // This release links its license from the README instead of shipping it.
          if (key !== "abstract-logging@2.0.1")
            throw new Error(`Missing license notice: ${key}`);
          notices.push(
            await readFile(
              resolve(root, "licenses/abstract-logging-2.0.1.txt"),
              "utf8",
            ),
          );
        }
        packages.set(
          key,
          `## ${key}\nLicense: ${manifest.license ?? "See notice"}\n\n${notices.join("\n\n")}`,
        );
      }
      break;
    }
    const parent = dirname(directory);
    if (parent === directory || !relative(resolve(root, "../.."), parent))
      throw new Error(`Package attribution missing: ${input}`);
    directory = parent;
  }
}
const upstreamLicense = await readFile(resolve(root, "../../LICENSE"), "utf8");
await writeFile(
  resolve(root, "dist/THIRD_PARTY_NOTICES.txt"),
  `Bundled component notices\n\n@openwork/features and other OpenWork source\n\n${upstreamLicense}\n\n${[
    ...packages,
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, notice]) => notice)
    .join("\n\n")}\n`,
);
await copyFile(resolve(root, "LICENSE"), resolve(root, "dist/LICENSE"));
