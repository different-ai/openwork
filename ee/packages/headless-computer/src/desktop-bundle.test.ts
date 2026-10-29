import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { isBuiltin } from "node:module"
import { build } from "esbuild"
import { GUEST_OPTIONAL_PACKAGES } from "../scripts/desktop-identity.mjs"

test("the guest and its identity don't depend on which optional packages the workspace has installed", async () => {
  const guest = await build({
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)), entryPoints: ["src/desktop-guest.mjs"], bundle: true,
    platform: "node", format: "esm", target: "node22", metafile: true, write: false, logLevel: "silent", external: GUEST_OPTIONAL_PACKAGES,
  })
  // A require esbuild can't resolve in this install would be bundled in one where it can, so each must be listed.
  const unresolved = Object.values(guest.metafile.inputs).flatMap(input => input.imports)
    .filter(imported => imported.external && imported.path !== "<runtime>" && !isBuiltin(imported.path)).map(imported => imported.path)
  assert.deepEqual([...new Set(unresolved)].filter(path => !GUEST_OPTIONAL_PACKAGES.includes(path)), [])
  // The real build leaves every listed package to a plain runtime require, even where this workspace installed it.
  const built = await readFile(new URL("../dist/desktop-guest.mjs", import.meta.url), "utf8")
  for (const name of GUEST_OPTIONAL_PACKAGES) assert.ok(built.includes(`require("${name}")`), `${name} must stay outside the guest bundle`)
})

test("the deployed desktop bundle carries its identities and guest without local package assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-bundle-"))
  try {
    const output = join(directory, "desktop.mjs")
    await build({ entryPoints: [fileURLToPath(new URL("./desktop.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm" })
    const image = await readFile(new URL("../dist/desktop-image.version", import.meta.url), "utf8")
    const guest = await readFile(new URL("../dist/desktop-guest.version", import.meta.url), "utf8")
    const bundle = await readFile(new URL("../dist/desktop-guest.mjs", import.meta.url))
    for (const privateBrowsing of [false, true]) {
      const expected = createHash("sha256").update(image).update(guest).update(privateBrowsing ? "private-browsing" : "").digest("hex")
      // This standalone module has no adjacent dist/ directory, just like a deployed celld Worker. It must still name
      // both identities to the helper and hand over the very guest the image would get.
      const program = `import assert from 'node:assert/strict';
        import { gunzipSync } from 'node:zlib';
        import { createHash } from 'node:crypto';
        import { Desktop } from ${JSON.stringify(pathToFileURL(output).href)};
        let guest = 'old-guest', installed = null;
        const uploads = new Map();
        const provider = { describe: () => ({ platform: { os: 'linux' } }), blocks: {
          files: { write: async (_box, path, bytes) => { uploads.set(path, bytes) } },
          run: async (_box, input) => {
            const start = input.command.match(/ start ([a-f0-9]{64}) ([a-f0-9]{64})$/);
            if (start) {
              assert.equal(start[1], ${JSON.stringify(image.trim())});
              if (guest !== start[2]) return { exitCode: 1, stdout: '', stderr: 'The desktop guest is out of date.' };
              return { exitCode: 0, stdout: '', stderr: '' };
            }
            const install = input.command.match(/ install [a-f0-9]{64} ([a-f0-9]{64}) ([a-f0-9]{64}) < (\\S+)$/);
            if (install) {
              installed = gunzipSync(uploads.get(install[3]));
              assert.equal(createHash('sha256').update(installed).digest('hex'), install[2]);
              guest = install[1];
              return { exitCode: 0, stdout: '', stderr: '' };
            }
            if (input.command.startsWith('rm -f')) return { exitCode: 0, stdout: '', stderr: '' };
            return { exitCode: 0, stdout: JSON.stringify({ version: guest === ${JSON.stringify(guest.trim())} ? ${JSON.stringify(expected)} : 'old' }), stderr: '' };
          } } };
        assert.equal(await new Desktop(provider, { privateBrowsing: ${privateBrowsing} }).start({ ref: { id: 'isolated' } }), 'current');
        assert.equal(createHash('sha256').update(installed).digest('hex'), ${JSON.stringify(createHash("sha256").update(bundle).digest("hex"))});
        console.log('guest installed');`
      assert.match(execFileSync(process.execPath, ["--input-type=module", "--eval", program], { encoding: "utf8", cwd: directory }), /guest installed/)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
