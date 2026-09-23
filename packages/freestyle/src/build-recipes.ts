import type { PreviewWorld } from "./index.ts";

export function toolsRecipe(world: PreviewWorld): string {
  return `corepack enable
corepack prepare pnpm@11.4.0 --activate
${world === "acme-web" ? `apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server redis-server xvfb x11vnc novnc websockify dbus-x11 xauth libgtk-3-0 libnss3 libasound2t64 libgbm1
# A real Linux desktop (as in Daytona previews): panel, window frames, terminal, files.
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfce4-terminal thunar
printf '<!doctype html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1&amp;resize=scale&amp;reconnect=1&amp;reconnect_delay=2000"><title>OpenWork desktop</title>' > /usr/share/novnc/index.html
systemctl enable --now mysql redis-server
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'password'; FLUSH PRIVILEGES;"` : ""}
mkdir -p /opt/openwork-preview/tools
printf 'allowBuilds:\\n  opencode-ai: true\\n' > /opt/openwork-preview/tools/pnpm-workspace.yaml
pnpm --dir /opt/openwork-preview/tools add opencode-ai@1.18.15
node /opt/openwork-preview/tools/node_modules/opencode-ai/postinstall.mjs
/opt/openwork-preview/tools/node_modules/.bin/opencode --version`;
}

export function dependencyRecipe(world: PreviewWorld): string {
  return `# Only manifests/config/patches remain when we install this reusable layer.
# No application lifecycle scripts or pnpm hooks may mutate the shared cache.
pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --filter @openwork/app... --filter openwork-server... --filter @openwork/world... ${world === "acme-web" ? "--filter @openwork-ee/den-api... --filter @openwork-ee/den-web... --filter @openwork-ee/gateway... --filter @openwork/desktop..." : ""}
pnpm --config.ignore-pnpmfile=true rebuild esbuild better-sqlite3 sharp node-pty electron @sentry/cli @whiskeysockets/baileys protobufjs
${world === "acme-web" ? "pnpm --dir evals install --frozen-lockfile --ignore-scripts --ignore-pnpmfile" : ""}`;
}

export function checkoutRecipe(sha: string): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed commit SHA is required.");
  return `git init /workspace
cd /workspace
git config core.hooksPath /dev/null
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/different-ai/openwork.git
git fetch --depth=1 origin ${sha}
git checkout --force --detach FETCH_HEAD
git clean -ffdx -e node_modules/
test "$(git rev-parse HEAD)" = "${sha}"`;
}

export function compiledRecipe(world: PreviewWorld): string {
  return `${world === "acme-web" ? `
(node apps/desktop/scripts/prepare-sidecar.mjs --force --outdir apps/desktop/resources/sidecars && node apps/desktop/scripts/prepare-computer-use-helper.mjs --force --outdir apps/desktop/resources/helpers) &
DESKTOP_BUILD=$!
pnpm --filter @openwork-ee/den-api run build:workspace-dependencies
pnpm --filter openwork-server build
wait "$DESKTOP_BUILD"
` : "pnpm --filter @openwork/types build\npnpm --filter @openwork/enterprise-mcp-client build"}
pnpm --filter @openwork/sdk build
# Archive generated workspace output only; runtime databases and credentials do not exist yet.
node --input-type=module - <<'NODE'
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
const paths = [];
for (const root of ['packages', 'ee/packages', 'apps', 'ee/apps']) {
  for (const dir of readdirSync(root)) {
    const path = root + '/' + dir + '/dist';
    if (existsSync(path)) paths.push(path);
  }
}
for (const path of ['apps/desktop/resources/sidecars', 'apps/desktop/resources/helpers']) {
  if (existsSync(path)) paths.push(path);
}
writeFileSync('/opt/openwork-preview/compiled-files', paths.join('\\0') + '\\0');
NODE
tar --null -T /opt/openwork-preview/compiled-files -cf /opt/openwork-preview/compiled.tar`;
}
