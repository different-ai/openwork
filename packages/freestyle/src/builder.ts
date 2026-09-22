import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { FreestyleApiError } from "freestyle";
import { client, execChecked, findSnapshot, isMissing, snapshotSlug, type PreviewWorld } from "./index.ts";

/** Build once per exact source revision, then clone the running, verified world. */
export async function ensureSnapshot(sha: string, api = client(), log: (message: string) => void = () => {}, world: PreviewWorld = "app-web") {
  const slug = snapshotSlug(sha, world);
  // ACME now boots the real desktop app as well; its first compile needs headroom.
  const deadline = Date.now() + 20 * 60_000;
  // The provider's unique slug is the distributed lock: works across Vercel instances.
  while (Date.now() < deadline) {
    const existing = await findSnapshot(sha, api, world);
    if (existing) return existing;
    let created;
    try {
      created = await api.vms.create({
        slug: `ow-build-${world}-v5-${sha}`, snapshotId: "freestyle/ubuntu",
        displayName: `OpenWork snapshot ${sha.slice(0, 7)}`, ttlSeconds: 1800,
        metadata: { kind: "openwork-snapshot-builder-v1", gitSha: sha },
        firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
      });
    } catch (error) {
      if (!(error instanceof FreestyleApiError) || error.status !== 409) throw error;
      // Capacity failures also use 409. Only wait when our builder actually exists.
      const builder = await api.vms.get(`ow-build-${world}-v5-${sha}`).catch((cause: unknown) => {
        if (isMissing(cause)) return null;
        throw cause;
      });
      if (!builder) {
        const completed = await findSnapshot(sha, api, world);
        if (completed) return completed;
        throw error;
      }
      if (builder.metadata.kind !== "openwork-snapshot-builder-v1" || builder.metadata.gitSha !== sha) throw error;
      await delay(2_000);
      continue;
    }
    const { vm } = created;
    try {
      log(`Building snapshot for ${sha} in ${vm.id}`);
      await execChecked(vm, "mkdir -p /opt/openwork-preview");
      await vm.fs.writeTextFile("/opt/openwork-preview/gateway.mjs", await readFile(new URL("./gateway.mjs", import.meta.url), "utf8"));
      await vm.fs.writeTextFile("/opt/openwork-preview/runtime.mjs", await readFile(new URL(world === "acme-web" ? "./acme-runtime.mjs" : "./runtime.mjs", import.meta.url), "utf8"));
      await vm.fs.writeTextFile("/opt/openwork-preview/health.mjs", await readFile(new URL("./health.mjs", import.meta.url), "utf8"));
      for (const file of ["origins.mjs", "resume.mjs", "desktop.mjs"]) {
        await vm.fs.writeTextFile(`/opt/openwork-preview/${file}`, await readFile(new URL(`./${file}`, import.meta.url), "utf8"));
      }
      // Only public repository bytes enter the VM. No host credentials or environment are forwarded.
      const setup = `#!/bin/bash
set -euo pipefail
exec > /opt/openwork-preview/build.log 2>&1
trap 'tail -n 50 /workspace/tmp/worlds/runtime/freestyle-preview/web.log /workspace/tmp/worlds/runtime/freestyle-preview/server.log 2>/dev/null || true; touch /opt/openwork-preview/failed' ERR
git init /workspace
cd /workspace
git remote add origin https://github.com/different-ai/openwork.git
git fetch --depth=1 origin ${sha}
git checkout --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "${sha}"
corepack enable
corepack prepare pnpm@11.4.0 --activate
${world === "acme-web" ? `apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server redis-server xvfb x11vnc novnc websockify fluxbox dbus-x11 xauth libgtk-3-0 libnss3 libasound2t64 libgbm1
# Open the viewer connected and scaled to the reviewer's window.
printf '<!doctype html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1&amp;resize=scale&amp;reconnect=1&amp;reconnect_delay=2000"><title>OpenWork desktop</title>' > /usr/share/novnc/index.html
systemctl enable --now mysql redis-server
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'password'; FLUSH PRIVILEGES;"
pnpm install --frozen-lockfile --filter @openwork/app... --filter openwork-server... --filter @openwork/world... --filter @openwork-ee/den-api... --filter @openwork-ee/den-web... --filter @openwork-ee/gateway... --filter @openwork/desktop...
pnpm --dir evals install --frozen-lockfile --ignore-scripts
pnpm --filter @openwork-ee/den-db build
pnpm --filter @openwork/email build` : "pnpm install --frozen-lockfile --filter @openwork/app... --filter openwork-server... --filter @openwork/world..."}
pnpm --filter @openwork/types build
pnpm --filter @openwork/sdk build
pnpm --filter @openwork/enterprise-mcp-client build
${world === "acme-web" ? "pnpm --filter @openwork-ee/den-api run build:workspace-dependencies" : ""}
mkdir -p /opt/openwork-preview/tools
printf 'allowBuilds:\n  opencode-ai: true\n' > /opt/openwork-preview/tools/pnpm-workspace.yaml
pnpm --dir /opt/openwork-preview/tools add opencode-ai@1.18.15
node /opt/openwork-preview/tools/node_modules/opencode-ai/postinstall.mjs
export PATH="/opt/openwork-preview/tools/node_modules/.bin:$PATH"
opencode --version
systemctl daemon-reload
${world === "app-web" ? "systemctl start openwork-preview-runtime\ncurl --retry 20 --retry-delay 2 --retry-all-errors -fsS http://127.0.0.1:5178/ >/dev/null\nnode /opt/openwork-preview/health.mjs" : `mysqladmin -uroot -ppassword ping
redis-cli ping
systemctl start openwork-preview-runtime
for attempt in $(seq 1 540); do
  test ! -f /opt/openwork-preview/failed-world
  if test -f /opt/openwork-preview/ready-world; then break; fi
  sleep 2
done
test -f /opt/openwork-preview/ready-world
node /opt/openwork-preview/health.mjs`}
systemctl enable --now openwork-preview-gateway
touch /opt/openwork-preview/ready
`;
      await vm.fs.writeTextFile("/opt/openwork-preview/setup.sh", setup);
      // Keep the app in its own service cgroup so completion of the builder
      // cannot kill the processes captured by the running snapshot.
      await vm.fs.writeTextFile("/etc/systemd/system/openwork-preview-runtime.service", `[Unit]
Description=OpenWork isolated preview runtime
[Service]
Type=${world === "app-web" ? "oneshot" : "simple"}
RemainAfterExit=${world === "app-web" ? "yes" : "no"}
WorkingDirectory=/workspace
Environment=PATH=/opt/openwork-preview/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/env node /opt/openwork-preview/runtime.mjs
`);
      await vm.fs.writeTextFile("/etc/systemd/system/openwork-preview-gateway.service", `[Unit]
Description=OpenWork private preview gateway
[Service]
ExecStart=/usr/bin/env node /opt/openwork-preview/gateway.mjs
Restart=on-failure
[Install]
WantedBy=multi-user.target
`);
      await execChecked(vm, "systemd-run --unit=openwork-preview-build /bin/bash /opt/openwork-preview/setup.sh");
      while (Date.now() < deadline) {
        const status = await execChecked(vm, "if test -f /opt/openwork-preview/failed; then echo failed; elif test -f /opt/openwork-preview/ready; then echo ready; else echo building; fi");
        if (status.trim() === "failed") throw new Error(`Snapshot build failed in ${vm.id}; inspect /opt/openwork-preview/build.log.`);
        if (status.trim() === "ready") {
          log("App is ready; saving its running snapshot.");
          const result = await vm.snapshot({ slug, displayName: `OpenWork ${sha.slice(0, 7)}`, autoDeleteSeconds: 7 * 86400 });
          return result.snapshot;
        }
        await delay(3_000);
      }
      throw new Error("Snapshot build exceeded 20 minutes. Try again after checking the builder logs.");
    } catch (error) {
      log(await vm.fs.readTextFile("/opt/openwork-preview/build.log").then((value) => value.slice(-6000), () => "Builder log unavailable."));
      throw error;
    } finally {
      // Snapshot survives deletion; no paid builder stays behind.
      await vm.delete().catch(() => log("Builder cleanup will be completed by its provider TTL."));
    }
  }
  throw new Error("Another snapshot build is still running. Try launching again shortly.");
}
