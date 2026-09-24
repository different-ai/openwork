import { readFile } from "node:fs/promises";
import { client } from "./index.ts";
import { runScript, type BuildOptions } from "./builder.ts";
import { toolsRecipe, dependencyRecipe, checkoutRecipe } from "./build-recipes.ts";
import { digest, sourceTree, dependencyFingerprint, dependencyInput, ensureLayer } from "./cache.ts";

/** Explicit web evidence recipe. Never restore the ordinary hosted-Den app-web template. */
export async function ensureEvidenceSnapshot(sha: string, api = client(), options: BuildOptions = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed source SHA is required");
  const entries = await sourceTree(sha, options.sourceFetch);
  const observe = options.observe ?? (() => {});
  const tools = toolsRecipe("acme-web") + `
cat > /opt/openwork-preview/evidence-chrome <<'CHROME'
#!/bin/sh
exec /usr/bin/google-chrome-stable --no-sandbox --disable-dev-shm-usage "$@"
CHROME
chmod 755 /opt/openwork-preview/evidence-chrome
`;
  const toolsSlug = `ow-evidence-tools-v1-${digest(tools)}`;
  const dependencies = dependencyRecipe("acme-web").replace("pnpm install --frozen-lockfile", "pnpm install --filter @openwork/freestyle... --frozen-lockfile");
  const depsSlug = `ow-evidence-deps-v1-${digest(toolsSlug + dependencies + dependencyFingerprint(entries))}`;
  const deps = await ensureLayer({ slug: depsSlug, stage: "evidence-deps", observe,
    parent: async () => (await ensureLayer({ slug: toolsSlug, stage: "evidence-tools", observe,
      parent: async () => "freestyle/ubuntu", prepare: (vm) => runScript(vm, "evidence-tools", tools, options) }, api)).id,
    prepare: async (vm) => {
      const inputs = entries.filter((entry) => entry.type === "blob" && dependencyInput(entry.path)).map((entry) => entry.path);
      await vm.fs.writeTextFile("/opt/openwork-preview/evidence-inputs.json", JSON.stringify(inputs));
      await runScript(vm, "evidence-deps", `${checkoutRecipe(sha)}
node --input-type=module - <<'NODE'
import { readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const keep = new Set(JSON.parse(await readFile('/opt/openwork-preview/evidence-inputs.json', 'utf8')));
for (const path of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0').filter(Boolean)) {
  if (!keep.has(path)) await rm(path, { force: true });
}
NODE
${dependencies}`, options);
    },
  }, api);
  const files = ["evidence-runtime.mjs", "evidence-control.mjs", "gateway.mjs", "origins.mjs"];
  const controller = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  // No frontend-only reuse here: every final template belongs to this exact SHA.
  return ensureLayer({ slug: `ow-evidence-web-v1-${digest(sha + depsSlug + controller.join("\n"))}`, stage: "evidence-world", observe, ttlSeconds: 86400,
    parent: async () => deps.id,
    prepare: async (vm) => {
      for (const [index, name] of files.entries()) await vm.fs.writeTextFile(`/opt/openwork-preview/${name}`, controller[index]);
      await vm.fs.writeTextFile("/etc/systemd/system/openwork-evidence.service", `[Unit]\nDescription=OpenWork isolated evidence web world\n[Service]\nWorkingDirectory=/workspace\nEnvironment=PATH=/opt/openwork-preview/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nExecStart=/usr/bin/env node /opt/openwork-preview/evidence-runtime.mjs\n`);
      await vm.fs.writeTextFile("/etc/systemd/system/openwork-evidence-gateway.service", `[Unit]\nDescription=Private evidence viewer\n[Service]\nExecStart=/usr/bin/env node /opt/openwork-preview/gateway.mjs\n`);
      await runScript(vm, "evidence-world", `${checkoutRecipe(sha)}
pnpm --filter @openwork-ee/den-api run build:workspace-dependencies
pnpm --filter openwork-server build
pnpm --filter @openwork/sdk build
systemctl daemon-reload
systemctl start openwork-evidence
for attempt in $(seq 1 480); do
  test ! -f /opt/openwork-preview/failed-world
  if test -f /opt/openwork-preview/evidence-ready; then break; fi
  sleep 1
done
test -f /opt/openwork-preview/evidence-ready
printf %s ${sha} > /opt/openwork-preview/source-sha
systemctl start openwork-evidence-gateway
`, options);
    },
  }, api);
}
