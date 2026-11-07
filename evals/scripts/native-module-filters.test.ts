import { test } from "@openwork/testkit";
import { expect } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const { FileMatcher, getNodeModuleFileMatcher, getMainFileMatchers } = builderRequire("app-builder-lib/out/fileMatcher.js");
const { doMergeConfigs } = builderRequire("app-builder-lib/out/util/config/config.js");
const { parse } = desktopRequire("yaml");
const { verifyNativeModules } = desktopRequire("./scripts/verify-native-modules.cjs");
const config = parse(readFileSync(new URL("../../apps/desktop/electron-builder.base.yml", import.meta.url), "utf8"));
const targets = ["darwin", "linux", "win32"];
const architectures = ["x64", "arm64"];
const sqliteTargets = ["darwin", "linux", "linuxmusl", "win32"];

for (const platform of targets) {
  for (const arch of architectures) {
    test(`${platform}/${arch} ships only its own SQLite and PTY natives, retaining Linux libc variants`, ({ evidence }) => {
      const root = mkdtempSync(join(tmpdir(), "exp-np-filters-"));
      try {
        const files: string[] = ["node_modules/better-sqlite3/package.json", "node_modules/better-sqlite3/lib/index.js", "node_modules/node-pty/index.js", "server/dist/unchanged.js"];
        for (const os of sqliteTargets) {
          for (const cpu of architectures) files.push(`node_modules/better-sqlite3/prebuilds/${os}-${cpu}.node`);
        }
        for (const os of targets) {
          for (const cpu of architectures) {
            const names = os === "win32" ? ["conpty.node", "conpty_console_list.node", "conpty.dll", "OpenConsole.exe"] : ["pty.node", "spawn-helper"];
            for (const prefix of ["node_modules", "node_modules/duplicate/node_modules"]) {
              const base = `${prefix}/@lydell/node-pty-${os}-${cpu}`;
              files.push(`${base}/package.json`, ...names.map((name) => `${base}/build/Release/${name}`));
            }
          }
        }
        // A nested SQLite copy must be filtered too, without changing its JS.
        files.push(...files.filter((file) => file.includes("/better-sqlite3/")).map((file) => `node_modules/duplicate/${file}`));
        for (const file of files) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), "fixture");
        }
        const mergedConfig = doMergeConfigs([structuredClone(config)]);
        const options = mergedConfig[platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux"];
        const expand = (pattern: string) => pattern.replaceAll("${arch}", arch);
        const debugLogger = { isEnabled: false };
        const mainMatchers = getMainFileMatchers(root, join(root, "destination"), expand, options, {
          info: { projectDir: root, buildResourcesDir: "build", config: mergedConfig, debugLogger },
        }, join(root, "out"), false);
        // OS-specific exclusions must not introduce an include-all root matcher.
        // That would silently ship scripts/resources/tests alongside the app.
        const rootMatchers = mainMatchers.filter((matcher: { from: string }) => matcher.from === root);
        expect(rootMatchers).toHaveLength(1);
        const mainFilter = rootMatchers[0].createFilter();
        for (const file of ["electron/main.mjs", "server/dist/unchanged.js", "package.json", "scripts/private.cjs", "resources/extra.bin", "test/extra.js", "server/dist/opencode-plugins/external.js"]) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), "fixture");
          expect(mainFilter(join(root, file), statSync(join(root, file)))).toBe(["electron/main.mjs", "server/dist/unchanged.js", "package.json"].includes(file));
        }
        evidence.recordAssertionEvidence("The desktop package file allowlist is unchanged", "Only electron, server and package.json are included; scripts, resources, tests and external plugin sources are excluded", true);
        const collected = getNodeModuleFileMatcher(root, root, expand, options, { config: mergedConfig, debugLogger }).createFilter();
        const stagedSet = options.files.find((file: { from?: string }) => file.from === ".electron-runtime/node_modules");
        const staged = new FileMatcher(root, root, expand, stagedSet.filter).createFilter();
        const expected = files.filter((file) => {
          const sqlite = /\/prebuilds\/([^/]+)\.node$/.exec(file);
          if (sqlite) return sqlite[1] === `${platform}-${arch}` || platform === "linux" && sqlite[1] === `linuxmusl-${arch}`;
          const pty = /\/@lydell\/node-pty-([^/]+)\//.exec(file);
          return !pty || pty[1] === `${platform}-${arch}`;
        });
        for (const os of targets) {
          for (const cpu of architectures) {
            const file = `node_modules/.pnpm/@lydell+node-pty-${os}-${cpu}@1.2.0/node_modules/@lydell/node-pty-${os}-${cpu}/build/Release/pty.node`;
            mkdirSync(dirname(join(root, file)), { recursive: true });
            writeFileSync(join(root, file), "fixture");
            for (const filter of [collected, staged]) {
              expect(filter(join(root, file), statSync(join(root, file)))).toBe(os === platform && cpu === arch);
            }
          }
        }
        for (const filter of [collected, staged]) {
          const kept = files.filter((file) => filter(resolve(root, file), statSync(join(root, file))));
          expect(kept).toEqual(expected);
          expect(() => verifyNativeModules(kept, platform, arch, root)).not.toThrow();
          const sqliteMissing = kept.filter((file) => !file.endsWith(`/prebuilds/${platform}-${arch}.node`));
          expect(() => verifyNativeModules(sqliteMissing, platform, arch, root)).toThrow("Missing target SQLite");
          const ptyMissing = kept.filter((file) => !file.includes("/@lydell/"));
          expect(() => verifyNativeModules(ptyMissing, platform, arch, root)).toThrow("Missing target PTY");
          expect(() => verifyNativeModules(files, platform, arch, root)).toThrow("Foreign");
          // PackContext's real numeric enum must select the same architecture.
          expect(() => verifyNativeModules(kept, platform, arch === "x64" ? 1 : 3, root)).not.toThrow();
          evidence.recordAssertionEvidence("Only target native modules survive both collector and staged-runtime filters", JSON.stringify(kept.filter((file) => file.endsWith(".node"))), true);
          evidence.recordAssertionEvidence("Missing target SQLite or PTY and foreign binaries fail the build", "Missing SQLite, missing PTY and unfiltered foreign natives each threw; string and PackContext numeric architectures accepted the valid set", true);
        }
        // Filters never mutate installed dependencies or standalone-server inputs.
        for (const file of files) expect(readFileSync(join(root, file), "utf8")).toBe("fixture");
        rmSync(join(root, `node_modules/better-sqlite3/prebuilds/${platform}-${arch}.node`));
        expect(() => verifyNativeModules(expected, platform, arch, root)).toThrow("Missing unpacked native");
        evidence.recordAssertionEvidence("Installed dependency inputs stay intact and ASAR references cannot hide a missing unpacked native", "Every original input retained its contents; removing the target unpacked SQLite file made verification fail", true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("unknown native targets fail closed", ({ evidence }) => {
  expect(() => verifyNativeModules([], "win32", "ia32", "/unused")).toThrow("Unsupported");
  expect(() => verifyNativeModules([], "freebsd", "x64", "/unused")).toThrow("Unsupported");
  evidence.recordAssertionEvidence("Unsupported targets cannot silently produce incomplete installers", "Windows ia32 and FreeBSD x64 both rejected before inspecting files", true);
});
