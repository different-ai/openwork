import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

test("adopted Daytona image contains only pinned v2 with integrity verification", () => {
  const dockerfile = readFileSync(new URL("../../den-worker-runtime/Dockerfile.daytona-snapshot", import.meta.url), "utf8")
  assert.match(dockerfile, /COPY --from=openwork-builder \/src\/constants\.json/)
  assert.match(dockerfile, /a\.version!==c\.opencodeV2Version/)
  assert.match(dockerfile, /amd64\) platform="linux-x64-baseline"/)
  assert.match(dockerfile, /arm64\) platform="linux-arm64"/)
  assert.ok(dockerfile.indexOf("createHash(\"sha512\")") < dockerfile.indexOf('tar -xzf "$tmpdir/opencode2.tgz"'))
  assert.match(dockerfile, /actual!==a\.platforms\[process\.argv\[1\]\]\.integrity/)
  assert.match(dockerfile, /install -m 0755 "\$tmpdir\/package\/bin\/opencode" \/usr\/local\/bin\/opencode2/)
  assert.match(dockerfile, /ENV OPENWORK_OPENCODE2_BIN=\/usr\/local\/bin\/opencode2/)
  assert.doesNotMatch(dockerfile, /OPENCODE_VERSION|OPENCODE_DOWNLOAD_URL|\/usr\/local\/bin\/opencode(?:;|\s|$)|&& opencode --version/)
  assert.match(dockerfile, /ENV OPENWORK_ENGINE_V2_ONLY=1/)
  assert.match(dockerfile, /\$OPENWORK_OPENCODE2_BIN" --version/)
  assert.match(dockerfile, /actual!==expected/)
  assert.match(dockerfile, /replace\(\/\^opencode v\?\//)
  // Baking a binary must not silently enable org policy evaluation in all images.
  assert.doesNotMatch(dockerfile, /ENV OPENWORK_(ENGINE_AUTO_UPGRADE|ENGINE_FORCE_POLICY|FRESH_INSTALL_ENGINE)=/)
})
