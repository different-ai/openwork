const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const asar = require("@electron/asar");

function loadWithPath(filename, pathImplementation) {
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function(require, module, exports, __dirname) { ${fs.readFileSync(filename, "utf8")}\n})`,
    { filename },
  );
  wrapper((name) => name === "node:path" || name === "path" ? pathImplementation : localRequire(name),
    module, module.exports, path.dirname(filename));
  return module.exports;
}

async function fixture(t, exports, extraFiles = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwork-after-pack-test-"));
  const archive = path.join(directory, "app.asar");
  t.after(() => {
    asar.uncache(archive);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, "source", "node_modules", "@openwork", "types");
  for (const [name, contents] of Object.entries({
    "package.json": JSON.stringify({ name: "@openwork/types", exports }),
    "dist/index.js": "module.exports = {};\n",
    ...extraFiles,
  })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  await asar.createPackage(path.join(directory, "source"), archive);
  return archive;
}

// Exercise the actual installed ASAR reader against real archive bytes, changing
// only its path traversal to Windows semantics. Keep physical I/O on this host.
function withArchivePaths(archive, pathImplementation, run) {
  const filesystemPath = path.join(path.dirname(require.resolve("@electron/asar")), "filesystem.js");
  const disk = require(path.join(path.dirname(filesystemPath), "disk.js"));
  const { Filesystem } = loadWithPath(filesystemPath, pathImplementation);
  const filesystem = new Filesystem(archive);
  filesystem.getRootPath = () => archive;
  const { header, headerSize } = disk.readArchiveHeaderSync(archive);
  filesystem.setHeader(header, headerSize);
  const original = disk.readFilesystemSync;
  disk.readFilesystemSync = (filename) => {
    assert.equal(filename, archive);
    return filesystem;
  };
  try {
    return run();
  } finally {
    disk.readFilesystemSync = original;
  }
}

for (const [platform, pathImplementation] of [["POSIX", path.posix], ["Windows", path.win32]]) {
  const { normalizeAsarEntryPath, verifyCompiledTypes } = loadWithPath(
    path.join(__dirname, "electron-after-pack.cjs"), pathImplementation,
  );
  const packagedFiles = (archive) => new Set(asar.listPackage(archive, { isPack: false })
    .map((entry) => normalizeAsarEntryPath(entry, pathImplementation.sep)));

  test(`${platform}: compiled exports pass using a real ASAR`, async (t) => {
    const archive = await fixture(t, { ".": "./dist/index.js" });
    withArchivePaths(archive, pathImplementation, () => {
      assert.doesNotThrow(() => verifyCompiledTypes(archive, packagedFiles(archive)));
    });
  });

  test(`${platform}: missing JavaScript exports fail closed`, async (t) => {
    const archive = await fixture(t, { ".": "./dist/missing.js" });
    withArchivePaths(archive, pathImplementation, () => {
      assert.throws(() => verifyCompiledTypes(archive, packagedFiles(archive)), /exports are not compiled JavaScript/);
    });
  });

  test(`${platform}: TypeScript export targets fail closed`, async (t) => {
    const archive = await fixture(t, { ".": "./src/index.ts" }, { "src/index.ts": "export {};" });
    withArchivePaths(archive, pathImplementation, () => {
      assert.throws(() => verifyCompiledTypes(archive, packagedFiles(archive)), /exports are not compiled JavaScript/);
    });
  });

  test(`${platform}: stray TypeScript source fails closed`, async (t) => {
    const archive = await fixture(t, { ".": "./dist/index.js" }, { "src/index.ts": "export {};" });
    withArchivePaths(archive, pathImplementation, () => {
      assert.throws(() => verifyCompiledTypes(archive, packagedFiles(archive)), /still ships TypeScript source/);
    });
  });
}

test("Windows ASAR traversal reproduces the forward-slash extraction failure", async (t) => {
  const archive = await fixture(t, { ".": "./dist/index.js" });
  withArchivePaths(archive, path.win32, () => {
    assert.throws(() => asar.extractFile(archive, "node_modules/@openwork/types/package.json"), /was not found in this archive/);
    const contents = asar.extractFile(archive, path.win32.join("node_modules", "@openwork", "types", "package.json"));
    assert.equal(JSON.parse(contents.toString("utf8")).name, "@openwork/types");
  });
});
