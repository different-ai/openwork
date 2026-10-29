import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const checksums = {
  amd64: "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6",
  arm64: "dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e",
}

for (const file of ["Dockerfile.daytona-server", "Dockerfile.daytona-vnc"]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8")
  const block = source.match(/^RUN set -eu;[\s\S]*?(?=\n\n)/m)?.[0]
  assert.ok(block, `${file} must explicitly install Node rather than inherit it`)
  const script = block.slice("RUN ".length).replaceAll("\\\n", "\n")

  test(`${file} pins official artifacts and preserves Daytona's launcher path`, () => {
    assert.equal(spawnSync("sh", ["-n"], { input: script }).status, 0)
    assert.match(script, /https:\/\/nodejs\.org\/dist\/v24\.22\.1\/node-v24\.22\.1-linux-\$node_arch\.tar\.xz/)
    for (const [arch, checksum] of Object.entries(checksums)) {
      assert.ok(script.includes(`${arch}) node_arch=${arch === "amd64" ? "x64" : "arm64"}; node_sha256=${checksum}`))
    }
    assert.ok(script.indexOf("sha256sum -c -") < script.indexOf("tar -xJf"))
    assert.match(source, /ENV PATH="\/usr\/local\/share\/nvm\/current\/bin:\$PATH"/)
    assert.ok(source.indexOf(block) < source.indexOf("/usr/local/share/nvm/current/bin/npm install"))
    assert.match(source, /USER daytona\nRUN test "\$\(node --version\)" = v24\.22\.1/)
    assert.match(source, /\bxz-utils\b/)
  })

  function runInstaller(arch, checksumFailure = false) {
    const root = mkdtempSync(join(tmpdir(), "openwork-node-image-"))
    const bin = join(root, "bin")
    const nvm = join(root, "nvm")
    const log = join(root, "events")
    mkdirSync(bin)
    const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 })
    stub("dpkg", 'echo "$TEST_ARCH"')
    stub("curl", 'test "$1" = -fsSL; test "$2" = -o; echo "$4" >> "$TEST_LOG"; echo archive > "$3"')
    stub("sha256sum", `read -r checksum archive
      test "$checksum" = "$TEST_CHECKSUM"
      test -f "$archive"
      echo verified >> "$TEST_LOG"
      test "$TEST_CHECKSUM_FAILURE" = 0`)
    stub("tar", `test "$1" = -xJf; test "$3" = -C
      echo extracted >> "$TEST_LOG"
      mkdir -p "$4/bin"
      printf '#!/bin/sh\\necho v24.22.1\\n' > "$4/bin/node"
      chmod +x "$4/bin/node"`)
    stub("chown", ":")
    const result = spawnSync("sh", ["-c", script.replaceAll("/usr/local/share/nvm", nvm)], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ARCH: arch, TEST_LOG: log,
        TEST_CHECKSUM: checksums[arch] ?? "", TEST_CHECKSUM_FAILURE: checksumFailure ? "1" : "0" },
    })
    return { root, nvm, result, events: existsSync(log) ? readFileSync(log, "utf8") : "" }
  }

  for (const arch of Object.keys(checksums)) {
    test(`${file} installs ${arch} and updates both NVM current and default`, () => {
      const run = runInstaller(arch)
      try {
        assert.equal(run.result.status, 0, run.result.stderr)
        assert.equal(readlinkSync(join(run.nvm, "current")), join(run.nvm, "versions/node/v24.22.1"))
        assert.equal(readFileSync(join(run.nvm, "alias/default"), "utf8"), "v24.22.1\n")
        assert.match(run.events, new RegExp(`node-v24\\.22\\.1-linux-${arch === "amd64" ? "x64" : "arm64"}\\.tar\\.xz`))
        assert.match(run.events, /verified\nextracted\n/)
      } finally { rmSync(run.root, { recursive: true, force: true }) }
    })
  }

  for (const [label, arch, failChecksum] of [["checksum mismatch", "amd64", true], ["unsupported architecture", "riscv64", false]]) {
    test(`${file} fails closed on ${label} before extraction or activation`, () => {
      const run = runInstaller(arch, failChecksum)
      try {
        assert.notEqual(run.result.status, 0)
        assert.doesNotMatch(run.events, /extracted/)
        assert.equal(existsSync(join(run.nvm, "current")), false)
      } finally { rmSync(run.root, { recursive: true, force: true }) }
    })
  }
}

test("workspace devcontainer documentation matches the pinned runtime", () => {
  const source = readFileSync(new URL("docker-compose.yml", import.meta.url), "utf8")
  assert.match(source, /Workspace container with Node 24\.22\.1/)
  assert.doesNotMatch(source, /Workspace container with Node 20/)
})
