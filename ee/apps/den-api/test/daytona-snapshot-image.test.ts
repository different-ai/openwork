import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

test("Daytona image bakes the pinned, integrity-checked v2 engine and asserts it", () => {
  const dockerfile = readFileSync(new URL("../../den-worker-runtime/Dockerfile.daytona-snapshot", import.meta.url), "utf8")
  // scripts/install-opencode2.mjs installs constants.json's opencodeV2Version
  // and verifies the archive against opencode-v2-artifacts.json.
  assert.match(dockerfile, /amd64\) target="bun-linux-x64"; triple="x86_64-unknown-linux-gnu"/)
  assert.match(dockerfile, /arm64\) target="bun-linux-arm64"; triple="aarch64-unknown-linux-gnu"/)
  assert.match(dockerfile, /node scripts\/install-opencode2\.mjs --outdir \/tmp\/opencode2 --target "\$triple"/)
  assert.match(dockerfile, /COPY --from=openwork-builder \/tmp\/opencode2\/opencode2 \/usr\/local\/bin\/opencode2/)
  assert.match(dockerfile, /&& opencode2 --version/)
  // OpenCode v1 is gone: no second engine is installed or asserted.
  assert.doesNotMatch(dockerfile, /\/usr\/local\/bin\/opencode(?!2)/)
  assert.doesNotMatch(dockerfile, /&& opencode --version/)
  // Baking a binary must not silently enable org policy evaluation in all images.
  assert.doesNotMatch(dockerfile, /ENV OPENWORK_(ENGINE_AUTO_UPGRADE|ENGINE_FORCE_POLICY|FRESH_INSTALL_ENGINE)=/)
})
