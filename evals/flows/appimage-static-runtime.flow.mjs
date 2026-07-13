import { spawnSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "appimage-static-runtime";
const DEFAULT_APPIMAGE = "/workspace/apps/desktop/dist-electron/openwork-linux-x86_64-*.AppImage";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function runInSandbox(ctx, script) {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const result = spawnSync(
    "daytona",
    ["exec", ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX, "--", "echo", encoded, "|", "base64", "-d", "|", "bash"],
    { encoding: "utf8", timeout: 120_000 },
  );
  ctx.assert(result.status === 0, `Daytona command failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function record(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
}

export default {
  id: FLOW_ID,
  title: "OpenWork AppImage runs without FUSE2 and remains updateable",
  kind: "internal",
  requiredEnv: ["OPENWORK_EVAL_DAYTONA_SANDBOX"],
  steps: [
    {
      name: "The host has FUSE3 without FUSE2",
      run: async (ctx) => {
        await ctx.prove("The validation host represents a modern FUSE3-only Linux system", {
          voiceover: vo[0],
          assert: async () => {
            const output = runInSandbox(ctx, `
set -euo pipefail
. /etc/os-release
printf 'OS=%s %s\\n' "$ID" "$VERSION_ID"
dpkg-query -W -f='PACKAGE=\${Package} STATUS=\${db:Status-Abbrev}\\n' fuse3 libfuse3-4
if ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; then
  printf 'LIBFUSE2=present\\n'
else
  printf 'LIBFUSE2=absent\\n'
fi
test -c /dev/fuse
printf 'DEV_FUSE=present\\n'
`);
            record(ctx, output.includes("PACKAGE=fuse3 STATUS=ii "), "The host has FUSE3 installed");
            record(ctx, output.includes("PACKAGE=libfuse3-4 STATUS=ii "), "The host has the FUSE3 runtime library installed");
            record(ctx, output.includes("LIBFUSE2=absent"), "The host does not provide libfuse.so.2");
            record(ctx, output.includes("DEV_FUSE=present"), "The host exposes /dev/fuse");
            ctx.output("FUSE3-only host audit", output.trim());
          },
        });
      },
    },
    {
      name: "The fixed AppImage reaches a working OpenWork session",
      run: async (ctx) => {
        await ctx.prove("The static-runtime AppImage starts and serves the packaged OpenWork UI", {
          voiceover: vo[1],
          assert: async () => {
            const appImage = ctx.env.OPENWORK_EVAL_APPIMAGE_PATH || DEFAULT_APPIMAGE;
            const output = runInSandbox(ctx, `
set -euo pipefail
APPIMAGE_PATTERN=${JSON.stringify(appImage)}
APPIMAGES=($APPIMAGE_PATTERN)
test "\${#APPIMAGES[@]}" -eq 1
APPIMAGE="\${APPIMAGES[0]}"
"$APPIMAGE" --appimage-version
pgrep -af '/tmp/.mount_openwo.*/openwork'
curl -sf http://127.0.0.1:9825/json/list
grep 'GET /workspaces 200' /tmp/appimage-fix-launch.log
`);
            record(ctx, output.includes("type2-runtime/commit/dd6cebe"), "The AppImage reports the static type-two runtime");
            record(ctx, output.includes("/tmp/.mount_openwo"), "The packaged AppImage process is running from its mounted image");
            record(ctx, output.includes('"title": "OpenWork"'), "The packaged Electron CDP target is ready");
            record(ctx, output.includes("GET /workspaces 200"), "The packaged embedded server answers workspace requests");
            ctx.output("Packaged AppImage runtime", output.trim());
          },
          screenshot: {
            name: "packaged-appimage-ready",
            requireText: ["OpenWork", "New session", "Ready for new tasks"],
            rejectText: ["Something went wrong"],
            hashIncludes: ["/workspace/"],
          },
        });
      },
    },
    {
      name: "Updater metadata matches the final AppImage",
      run: async (ctx) => {
        await ctx.prove("The updater manifest matches the static-runtime AppImage", {
          voiceover: vo[2],
          assert: async () => {
            const appImage = ctx.env.OPENWORK_EVAL_APPIMAGE_PATH || DEFAULT_APPIMAGE;
            const output = runInSandbox(ctx, `
set -euo pipefail
APPIMAGE_PATTERN=${JSON.stringify(appImage)}
APPIMAGES=($APPIMAGE_PATTERN)
test "\${#APPIMAGES[@]}" -eq 1
APPIMAGE="\${APPIMAGES[0]}"
MANIFEST="$(dirname "$APPIMAGE")/latest-linux.yml"
ACTUAL_SIZE=$(stat -c '%s' "$APPIMAGE")
MANIFEST_SIZE=$(grep -m1 '^    size:' "$MANIFEST" | tr -dc '0-9')
ACTUAL_HASH=$(openssl dgst -sha512 -binary "$APPIMAGE" | base64 -w0)
MANIFEST_HASH=$(grep -m1 '^    sha512:' "$MANIFEST" | cut -d ' ' -f 6)
BLOCK_MAP_SIZE=$(grep -m1 '^    blockMapSize:' "$MANIFEST" | tr -dc '0-9')
printf 'ACTUAL_SIZE=%s\\nMANIFEST_SIZE=%s\\nACTUAL_HASH=%s\\nMANIFEST_HASH=%s\\nBLOCK_MAP_SIZE=%s\\n' \
  "$ACTUAL_SIZE" "$MANIFEST_SIZE" "$ACTUAL_HASH" "$MANIFEST_HASH" "$BLOCK_MAP_SIZE"
test "$ACTUAL_SIZE" = "$MANIFEST_SIZE"
test "$ACTUAL_HASH" = "$MANIFEST_HASH"
test "$BLOCK_MAP_SIZE" -gt 0
`);
            const values = Object.fromEntries(output.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
            record(ctx, values.ACTUAL_SIZE === values.MANIFEST_SIZE, "The updater manifest records the exact AppImage size", values.ACTUAL_SIZE);
            record(ctx, values.ACTUAL_HASH === values.MANIFEST_HASH, "The updater manifest records the exact AppImage SHA-512", values.ACTUAL_HASH);
            record(ctx, Number(values.BLOCK_MAP_SIZE) > 0, "The updater manifest retains an embedded blockmap", values.BLOCK_MAP_SIZE);
            ctx.output("Updater artifact verification", output.trim());
          },
        });
      },
    },
  ],
};
