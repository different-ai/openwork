import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export function prepareServerConstants(serverDistDir, constantsSrc) {
  const target = join(serverDistDir, "constants.json");
  copyFileSync(constantsSrc, target);

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const source = readFileSync(file, "utf8");
        const patched = source.replace(/from\s+(["'])(\.[^"']*\/constants\.json)\1/g, (match, quote, specifier) => {
          if (resolve(dirname(file), specifier) !== resolve(constantsSrc)) return match;
          const path = relative(dirname(file), target).split("\\").join("/");
          return `from ${quote}${path.startsWith(".") ? path : `./${path}`}${quote}`;
        });
        if (patched !== source) writeFileSync(file, patched, "utf8");
      }
    }
  }

  visit(serverDistDir);
}
