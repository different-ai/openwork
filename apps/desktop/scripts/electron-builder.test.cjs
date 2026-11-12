const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const builderRequire = createRequire(require.resolve("electron-builder"));
const { FileMatcher } = builderRequire("app-builder-lib/out/fileMatcher");
const yaml = builderRequire("js-yaml");
const config = yaml.load(fs.readFileSync(path.join(__dirname, "..", "electron-builder.base.yml"), "utf8"));

for (const [name, patterns, prefix] of [
  ["application files", config.files.filter((entry) => typeof entry === "string"), "server/native"],
  ["staged runtime", config.files.find((entry) => entry.from === ".electron-runtime/node_modules").filter, "node-pty/build/Release"],
]) {
  test(`${name}: exclude dSYM bundles without excluding native executables`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwork-builder-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filter = new FileMatcher(root, path.join(root, "out"), (value) => value, patterns).createFilter();
    const bundle = `${prefix}/pty.node.dSYM`;
    const debugFile = `${bundle}/Contents/Resources/DWARF/pty.node`;
    for (const name of [`${prefix}/pty.node`, `${prefix}/native.dll`, `${prefix}/helper.exe`, debugFile, `${bundle}/Contents/Info.plist`]) {
      const filename = path.join(root, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, "fixture");
    }
    for (const name of [bundle, debugFile, `${bundle}/Contents/Info.plist`]) {
      const filename = path.join(root, name);
      assert.equal(filter(filename, fs.statSync(filename)), false, name);
    }
    for (const name of [`${prefix}/pty.node`, `${prefix}/native.dll`, `${prefix}/helper.exe`]) {
      const filename = path.join(root, name);
      assert.equal(filter(filename, fs.statSync(filename)), true, name);
    }
  });
}
