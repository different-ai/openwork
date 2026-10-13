import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { mergeRuntimeEnv, reconcileInjectedUserEnv } from "./runtime-env.mjs";

const gitPath = "C:\\Tools\\Git;C:\\Windows\\System32";
const savedPath = "C:\\Tools\\Saved";
const overridePath = "C:\\Tools\\Override";

for (const alias of ["path", "Path", "PATH", "pAtH"]) {
  test(`Windows ${alias} preserves inherited PATH over saved aliases`, () => {
    const inherited = { [alias]: gitPath, TOKEN: "inherited" };
    const saved = { PATH: savedPath, path: "C:\\Tools\\Other", TOKEN: "saved" };
    const env = mergeRuntimeEnv("win32", saved, inherited);
    assert.deepEqual(env, { PATH: gitPath, TOKEN: "inherited" });
    assert.deepEqual(inherited, { [alias]: gitPath, TOKEN: "inherited" });
    assert.deepEqual(saved, { PATH: savedPath, path: "C:\\Tools\\Other", TOKEN: "saved" });
    assert.deepEqual(mergeRuntimeEnv("win32", saved, inherited, { Path: overridePath }), {
      PATH: overridePath, TOKEN: "inherited",
    });
  });

  test(`Windows reconciliation does not inject saved ${alias} over inherited PATH`, () => {
    const processEnv = { Path: gitPath, TOKEN: "inherited" };
    const keys = reconcileInjectedUserEnv({
      processEnv, inheritedEnv: { Path: gitPath, TOKEN: "inherited" },
      userEnv: { [alias]: savedPath, TOKEN: "saved", EXTRA: "saved" }, platform: "win32",
    });
    assert.deepEqual(processEnv, { Path: gitPath, TOKEN: "inherited", EXTRA: "saved" });
    assert.deepEqual([...keys], ["EXTRA"]);
  });
}

test("Windows conflicting aliases follow Node's lexicographic precedence within each layer", () => {
  assert.deepEqual(mergeRuntimeEnv("win32", { path: savedPath, Path: overridePath, PATH: gitPath }), {
    PATH: gitPath,
  });
  assert.deepEqual(mergeRuntimeEnv("win32", { PATH: gitPath }, { path: savedPath, Path: overridePath }), {
    PATH: overridePath,
  });
  assert.deepEqual(mergeRuntimeEnv("win32", { Path: gitPath }, { path: "" }), { PATH: "" });
});

test("Windows saved PATH changes spelling, updates, and is removed without leaving aliases", () => {
  const processEnv = {};
  let keys = reconcileInjectedUserEnv({
    processEnv, inheritedEnv: {}, userEnv: { path: savedPath }, platform: "win32",
  });
  assert.deepEqual(processEnv, { PATH: savedPath });
  assert.deepEqual([...keys], ["PATH"]);
  // The embedded server writes its enriched environment back to the parent.
  Object.assign(processEnv, { PATH: `C:\\Tools\\Sidecars;${savedPath}` });
  keys = reconcileInjectedUserEnv({
    processEnv, inheritedEnv: {}, userEnv: { Path: overridePath },
    previouslyInjectedKeys: keys, platform: "win32",
  });
  assert.deepEqual(processEnv, { PATH: overridePath });
  keys = reconcileInjectedUserEnv({
    processEnv, inheritedEnv: {}, userEnv: {}, previouslyInjectedKeys: keys, platform: "win32",
  });
  assert.deepEqual(processEnv, {});
  assert.equal(keys.size, 0);
});

for (const userEnv of [{}, { path: savedPath }]) {
  test(`Windows restores inherited PATH for previously tracked aliases with ${Object.keys(userEnv).length} saved keys`, () => {
    const processEnv = { path: savedPath, PATH: "C:\\Tools\\Sidecars" };
    const keys = reconcileInjectedUserEnv({
      processEnv, inheritedEnv: { Path: gitPath }, userEnv,
      previouslyInjectedKeys: new Set(["path"]), platform: "win32",
    });
    assert.deepEqual(processEnv, { PATH: gitPath });
    assert.equal(keys.size, 0);
  });
}

test("non-PATH variables retain exact-key inheritance and injection behavior", () => {
  const processEnv = { TOKEN: "inherited", token: "old", REMOVED: "old" };
  const keys = reconcileInjectedUserEnv({
    processEnv, inheritedEnv: { TOKEN: "inherited" }, userEnv: { TOKEN: "saved", token: "new" },
    previouslyInjectedKeys: new Set(["token", "REMOVED"]), platform: "win32",
  });
  assert.deepEqual(processEnv, { TOKEN: "inherited", token: "new" });
  assert.deepEqual([...keys], ["token"]);
});

for (const platform of ["linux", "darwin"]) {
  test(`${platform} keeps PATH aliases case-sensitive`, () => {
    assert.deepEqual(mergeRuntimeEnv(platform, { Path: savedPath, path: savedPath }, { PATH: gitPath }), {
      Path: savedPath, path: savedPath, PATH: gitPath,
    });
    const processEnv = { PATH: gitPath };
    const keys = reconcileInjectedUserEnv({
      processEnv, inheritedEnv: { PATH: gitPath }, userEnv: { path: savedPath }, platform,
    });
    assert.deepEqual(processEnv, { PATH: gitPath, path: savedPath });
    assert.deepEqual([...keys], ["path"]);
    reconcileInjectedUserEnv({ processEnv, inheritedEnv: { PATH: gitPath }, userEnv: {}, previouslyInjectedKeys: keys, platform });
    assert.deepEqual(processEnv, { PATH: gitPath });
  });
}

test("runtime child environment enrichment preserves lowercase inherited PATH and explicit overrides", async () => {
  const source = await readFile(new URL("./runtime.mjs", import.meta.url), "utf8");
  const match = source.match(/  async function buildChildEnv\(extra = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(match, "Exercise the actual child environment builder");
  const enrichment = source.match(/function enrichedPath\(sidecarDirs, currentPath\) \{[\s\S]*?\n\}/);
  assert.ok(enrichment, "Exercise the actual PATH enrichment");
  const processEnv = { path: gitPath };
  const sidecars = "C:\\Tools\\Sidecars";
  const build = runInNewContext(`${enrichment[0]}; (${match[0].trim()})`, {
    process: { env: processEnv, platform: "win32" },
    inheritedProcessEnv: { ...processEnv }, injectedUserEnvKeys: new Set(),
    loadUserEnvFile: () => ({ Path: savedPath }), mergeRuntimeEnv,
    reconcileInjectedUserEnv: options => reconcileInjectedUserEnv({ ...options, platform: "win32" }),
    systemCa: async () => ({ childEnv: {} }),
    mergeSystemCaChildEnv: (base, ca, extra) => ({ ...base, ...ca, ...extra }),
    sidecarDirs: [sidecars],
    path: path.win32, isDirectory: () => true, extraPathEntries: () => [],
  });
  const env = await build();
  assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === "PATH"), ["PATH"]);
  assert.equal(env.PATH, `${sidecars};${gitPath}`);
  Object.assign(processEnv, env);
  assert.equal(processEnv.PATH, `${sidecars};${gitPath}`);
  const overridden = await build({ pAtH: overridePath });
  assert.deepEqual(Object.keys(overridden).filter(key => key.toUpperCase() === "PATH"), ["PATH"]);
  assert.equal(overridden.PATH, `${sidecars};${overridePath}`);
});

test("native Windows process.env retains inherited PATH when saved casing differs", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    import { mergeRuntimeEnv, reconcileInjectedUserEnv } from ${JSON.stringify(new URL("./runtime-env.mjs", import.meta.url).href)};
    for (const alias of Object.keys(process.env).filter(key => key.toUpperCase() === "PATH")) delete process.env[alias];
    process.env.path = ${JSON.stringify(gitPath)};
    const inheritedEnv = { ...process.env };
    const userEnv = { PATH: ${JSON.stringify(savedPath)} };
    const keys = reconcileInjectedUserEnv({ processEnv: process.env, inheritedEnv, userEnv });
    assert.equal(keys.size, 0);
    const env = mergeRuntimeEnv(process.platform, userEnv, process.env);
    Object.assign(process.env, env);
    assert.equal(process.env.Path, ${JSON.stringify(gitPath)});
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.PATH)"], { env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, ${JSON.stringify(gitPath)});
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
