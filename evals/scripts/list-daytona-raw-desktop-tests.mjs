import { readdir, readFile } from "node:fs/promises";

const specs = new URL("../specs/", import.meta.url);
const files = (await readdir(specs))
  .filter((file) => file.endsWith(".e2e.test.ts"))
  .sort();

for (const file of files) {
  const source = await readFile(new URL(file, specs), "utf8");
  if (/import\s*\{[^}]*\bdesktop\b[^}]*\}\s*from\s*["']@openwork\/hosts["']/s.test(source)) {
    console.log(file);
  }
}
