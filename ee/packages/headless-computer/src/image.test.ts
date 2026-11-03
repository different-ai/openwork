import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { COMPUTER_INSTALL_SCRIPT, DESKTOP_COMPUTER_INSTALL_SCRIPT } from "./image.ts"

for (const [name, script] of [["computer", COMPUTER_INSTALL_SCRIPT], ["desktop", DESKTOP_COMPUTER_INSTALL_SCRIPT]]) {
  test(`${name} installs verified official Node 24.22.1 instead of distro Node`, () => {
    assert.ok(script)
    execFileSync("bash", ["-n"], { input: script })
    assert.doesNotMatch(script, /\bnodejs npm\b/)
    assert.match(script, /https:\/\/nodejs\.org\/dist\/v24\.22\.1\/node-v24\.22\.1-linux-\$node_arch\.tar\.xz/)
    assert.match(script, /amd64\) node_arch=x64; node_sha256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6/)
    assert.match(script, /arm64\) node_arch=arm64; node_sha256=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e/)
    assert.match(script, /\*\) echo "Unsupported Node architecture" >&2; exit 1/)
    assert.ok(script.indexOf("sha256sum -c -") < script.indexOf("tar -xJf"))
    assert.match(script, /test "\$\(node --version\)" = v24\.22\.1/)
  })
}
