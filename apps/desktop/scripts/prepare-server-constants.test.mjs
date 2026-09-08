import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { prepareServerConstants } from "./prepare-server-constants.mjs";

test("server and v2 modules load constants after relocation without the source checkout", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "openwork-packaged-constants-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const dist = join(repo, "apps/server/dist");
  mkdirSync(join(dist, "nested"), { recursive: true });
  writeFileSync(join(repo, "constants.json"), JSON.stringify({ opencodeV2Version: "fixture-v2" }));
  writeFileSync(join(dist, "package.json"), '{"type":"module"}');
  for (const name of ["server.js", "engine-v2-preview.js", "future-module.js"]) {
    writeFileSync(join(dist, name), 'import constants from "../../../constants.json" with { type: "json" }; export default constants.opencodeV2Version;');
  }
  writeFileSync(join(dist, "nested/module.js"), "import constants from '../../../../constants.json' with { type: 'json' }; export default constants.opencodeV2Version;");
  writeFileSync(join(dist, "unrelated.js"), 'export { default } from "./other/constants.json";');
  prepareServerConstants(dist, join(repo, "constants.json"));
  prepareServerConstants(dist, join(repo, "constants.json"));
  assert.equal(readFileSync(join(dist, "unrelated.js"), "utf8"), 'export { default } from "./other/constants.json";');
  const packaged = join(root, "Resources/app.asar/server/dist");
  cpSync(dist, packaged, { recursive: true });
  rmSync(repo, { recursive: true });
  for (const name of ["server.js", "engine-v2-preview.js", "future-module.js", "nested/module.js"]) {
    const loaded = await import(pathToFileURL(join(packaged, name)).href);
    assert.equal(loaded.default, "fixture-v2");
  }
});
