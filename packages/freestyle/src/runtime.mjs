import { mkdir, writeFile } from "node:fs/promises";
import { launchHeadlessWeb } from "/workspace/packages/world/src/headless-web.ts";

const root = "/opt/openwork-preview/state";
for (const dir of ["home", "cache", "config/openwork", "config/opencode", "data/openwork", "data/opencode", "workspace"]) {
  await mkdir(`${root}/${dir}`, { recursive: true });
}
const runtime = await launchHeadlessWeb({
  repoRoot: "/workspace", name: "freestyle-preview", state: "isolated",
  workspace: `${root}/workspace`, browserHostSuffix: ".style.dev",
  env: {
    PATH: process.env.PATH,
    // Dependencies were verified before snapshotting; changing HOME must not trigger a reinstall.
    pnpm_config_verify_deps_before_run: "false",
    HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data`, XDG_CACHE_HOME: `${root}/cache`,
    OPENWORK_DATA_DIR: `${root}/data/openwork`, OPENWORK_ENV_STORE: `${root}/config/openwork/env.json`,
    OPENWORK_SERVER_STATE_PATH: `${root}/data/openwork/server-state.json`,
    OPENWORK_SERVER_TOKEN_STORE_PATH: `${root}/data/openwork/server-tokens.json`,
    OPENCODE_CONFIG_DIR: `${root}/config/opencode`, OPENCODE_DB: `${root}/data/opencode/opencode.db`,
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: "https://app.openworklabs.com", VITE_DISABLE_OPENWORK_MODELS: "0",
    VITE_OPENWORK_POSTHOG_KEY: "", VITE_OPENWORK_SENTRY_DSN: "",
    OPENWORK_PORT: "8778", OPENWORK_WEB_PORT: "5178", HOST: "127.0.0.1", VITE_HOST: "127.0.0.1",
  },
});
await writeFile("/opt/openwork-preview/services.json", JSON.stringify({ app: runtime.manifest.webUrl, engine: runtime.manifest.openworkUrl }), { mode: 0o600 });
await writeFile("/opt/openwork-preview/outputs.json", JSON.stringify({
  openworkToken: { value: runtime.manifest.token, secret: true, group: "OpenWork" },
  openworkHostToken: { value: runtime.manifest.hostToken, secret: true, group: "OpenWork" },
}), { mode: 0o600 });
await runtime.detach();
