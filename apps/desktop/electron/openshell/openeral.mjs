// OpenEral sandbox lifecycle. Mirrors the minimal canonical incantation
// the openeral maintainers run by hand to launch Claude Code:
//
//   export ANTHROPIC_API_KEY='sk-ant-...'
//   export DATABASE_URL='postgresql://...'
//
//   printf '%s' "$DATABASE_URL" > /tmp/openeral-db-url
//   chmod 600 /tmp/openeral-db-url
//
//   openshell gateway start   # installer already does this
//
//   openshell sandbox create --tty \
//     --from ghcr.io/sandys/openeral/sandbox:just-bash \
//     --upload /tmp/openeral-db-url:/sandbox/db-url \
//     --provider claude --auto-providers \
//     -- openeral
//
//   rm -f /tmp/openeral-db-url
//
// Why this shape:
//   - DATABASE_URL lives in a FILE (one file, not a directory) inside
//     the distro at /tmp/openeral-db-url, uploaded to /sandbox/db-url.
//     The openeral image's setup.sh reads it from there.
//   - ANTHROPIC_API_KEY rides in via the env var. --auto-providers
//     auto-discovers the `claude` provider's credential from the host
//     env when sandbox create runs.
//   - We set ANTHROPIC_API_KEY on the wsl.exe process and add its name
//     to WSLENV so WSL forwards it into the Linux side where openshell
//     reads it.
//   - --tty (not --no-tty) — Claude Code requires a TTY. We later
//     attach via `openshell sandbox connect` over node-pty.
//   - Trailing command is `openeral` — a wrapper binary in the image
//     that runs setup.sh + the agent.
//   - No --gateway: relies on the active selected gateway, which the
//     installer registers via `gateway add --local --name openshell`
//     and selects via `gateway select`.

import { getCliInfo } from "./cli.mjs";
import { getCredential } from "./openeral-credentials.mjs";
import { DISTRO_NAME, wslRun, wslSpawn } from "./wsl.mjs";

const SANDBOX_IMAGE = "ghcr.io/sandys/openeral/sandbox:just-bash";
const IMAGE_BY_PROFILE = {
  "openeral-claude": SANDBOX_IMAGE,
  "openeral-openclaw": SANDBOX_IMAGE,
};

const DEFAULT_PULL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CREATE_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export function imageForProfile(profile) {
  const img = IMAGE_BY_PROFILE[profile];
  if (!img) throw new Error(`Unknown OpenEral profile: ${profile}`);
  return img;
}

/**
 * Pull the OpenEral image into the distro's Docker. Streamed via
 * wslSpawn so a long-running pull shows incremental progress.
 *
 * @param {string} imageRef
 * @param {{ onProgress?: (text: string) => void, timeoutMs?: number }} [options]
 */
export async function pullImage(imageRef, options = {}) {
  const { onProgress, timeoutMs = DEFAULT_PULL_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    const child = wslSpawn(["-d", DISTRO_NAME, "--", "docker", "pull", imageRef]);
    let lastStderr = "";
    const tail = (chunk) => {
      const text = chunk.toString("utf8");
      lastStderr = text;
      onProgress?.(text);
    };
    child.stdout.on("data", tail);
    child.stderr.on("data", tail);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error(`docker pull ${imageRef} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`docker pull ${imageRef} failed (exit ${code}): ${lastStderr.trim()}`));
    });
  });
}

/**
 * True if a sandbox with this name is registered. Used to short-circuit
 * createOpenEralSandbox when re-opening a workspace.
 *
 * Tolerates the flat-array (`[...]`) and envelope (`{sandboxes:[...]}`,
 * `{items:[...]}`) JSON shapes the upstream CLI has emitted across releases.
 */
export async function sandboxExists(name) {
  if (!name) return false;
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--", "openshell", "sandbox", "list", "--json"],
    { timeout: 10_000 },
  );
  if (r.exitCode !== 0) return false;
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return false;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.sandboxes)
      ? parsed.sandboxes
      : Array.isArray(parsed?.items)
        ? parsed.items
        : null;
  if (!list) return false;
  return list.some((s) => {
    if (typeof s === "string") return s === name;
    return s?.name === name;
  });
}

/**
 * Stage DATABASE_URL into a one-shot file inside the distro at
 * /tmp/openeral-db-url-<random>, with mode 0600. The value never
 * touches the Windows filesystem — it flows through wsl.exe stdin and
 * is written by bash inside the distro.
 *
 * Returns the in-distro path and a cleanup() that removes the file.
 */
async function stageDbUrlFile(databaseUrl) {
  const script =
    `set -e; umask 077; ` +
    `f=$(mktemp /tmp/openeral-db-url-XXXXXXXX); ` +
    `cat > "$f"; ` +
    `chmod 600 "$f"; ` +
    `printf '%s' "$f"`;
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-c", script],
    { timeout: 10_000, stdin: databaseUrl },
  );
  if (r.exitCode !== 0 || !r.stdout.trim()) {
    throw new Error(
      `Could not stage DATABASE_URL inside distro: ` +
        `${(r.stderr || r.stdout).trim() || "no output"}`,
    );
  }
  const wslPath = r.stdout.trim();
  return {
    wslPath,
    cleanup: async () => {
      await wslRun(
        ["-d", DISTRO_NAME, "--", "rm", "-f", "--", wslPath],
        { timeout: 5_000 },
      ).catch(() => {
        // Best-effort. A leaked /tmp file is reaped on the next distro
        // reboot or `wsl --shutdown`.
      });
    },
  };
}

/**
 * Build the wsl.exe env that forwards ANTHROPIC_API_KEY (and, for the
 * openclaw profile, OPENERAL_AGENT) into the Linux side. WSL only
 * forwards env vars whose names appear in WSLENV.
 */
function buildWslEnvForwarding(extra) {
  const forwardedNames = Object.keys(extra);
  const existingWslEnv = process.env.WSLENV ? [process.env.WSLENV] : [];
  return {
    ...process.env,
    ...extra,
    WSLENV: [...existingWslEnv, ...forwardedNames].join(":"),
  };
}

/**
 * Create (or resume into) an OpenEral sandbox. Sandbox naming is stable
 * per-workspace — re-running with the same name on the same Postgres
 * is OpenEral's whole portability story.
 *
 * @param {Object} opts
 * @param {string} opts.name
 * @param {"openeral-claude"|"openeral-openclaw"} opts.profile
 * @param {(evt: {phase: string, message: string}) => void} [opts.onProgress]
 * @param {boolean} [opts.skipImagePull]  Skip the docker pull (testing)
 * @param {number} [opts.createTimeoutMs]
 */
export async function createOpenEralSandbox(opts) {
  const { name, profile, onProgress, skipImagePull = false } = opts;
  if (!name) throw new Error("createOpenEralSandbox: name is required");
  if (!profile) throw new Error("createOpenEralSandbox: profile is required");

  const imageRef = imageForProfile(profile);

  // Short-circuit if the sandbox already exists (workspace reopen).
  if (await sandboxExists(name)) {
    onProgress?.({ phase: "exists", message: `Sandbox ${name} already exists; reconnecting.` });
    return { name, profile, imageRef, existed: true };
  }

  // Validate credentials.
  const databaseUrl = await getCredential("databaseUrl");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured. Set it in Settings → Sandbox → OpenEral configuration.",
    );
  }
  const anthropicApiKey = await getCredential("anthropicApiKey");
  if (!anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured. Set it in Settings → Sandbox → OpenEral configuration.",
    );
  }

  // Image pull (~1.5 GB on first run for :just-bash).
  if (!skipImagePull) {
    onProgress?.({ phase: "pull", message: `Pulling ${imageRef}...` });
    await pullImage(imageRef, {
      onProgress: (text) => onProgress?.({ phase: "pull", message: text.trimEnd() }),
    });
  }

  // Stage DATABASE_URL → /tmp/openeral-db-url-XXXXXX inside the distro.
  onProgress?.({ phase: "stage", message: "Staging DATABASE_URL..." });
  const dbFile = await stageDbUrlFile(databaseUrl);

  try {
    // Env vars to forward into the distro via WSLENV. ANTHROPIC_API_KEY
    // is always forwarded; for the openclaw profile we additionally set
    // OPENERAL_AGENT=openclaw so the openeral wrapper picks the right
    // agent at runtime.
    const forwarded = { ANTHROPIC_API_KEY: anthropicApiKey };
    if (profile === "openeral-openclaw") {
      forwarded.OPENERAL_AGENT = "openclaw";
    }
    const env = buildWslEnvForwarding(forwarded);

    onProgress?.({ phase: "create", message: `Creating sandbox ${name}...` });
    const r = await wslRun(
      [
        "-d", DISTRO_NAME, "--",
        "openshell", "sandbox", "create",
        "--tty",
        "--name", name,
        "--from", imageRef,
        "--upload", `${dbFile.wslPath}:/sandbox/db-url`,
        "--provider", "claude",
        "--auto-providers",
        "--",
        "openeral",
      ],
      {
        timeout: opts.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS,
        env,
      },
    );
    if (r.exitCode !== 0) {
      const cli = await getCliInfo().catch(() => null);
      const versionTag = cli?.version ? ` [CLI ${cli.version}]` : "";
      throw new Error(
        `openshell sandbox create failed (exit ${r.exitCode})${versionTag}: ` +
          `${(r.stderr || r.stdout).trim() || "(no output)"}`,
      );
    }
    onProgress?.({ phase: "ready", message: `Sandbox ${name} ready.` });
    return { name, profile, imageRef, existed: false };
  } finally {
    await dbFile.cleanup();
  }
}

export async function deleteOpenEralSandbox(name) {
  if (!name) throw new Error("deleteOpenEralSandbox: name is required");
  return wslRun(
    ["-d", DISTRO_NAME, "--", "openshell", "sandbox", "delete", name, "--force"],
    { timeout: 30_000 },
  );
}

/**
 * Live database-reachability probe. Runs psql via a transient
 * `postgres:16-alpine` container inside the distro. Pulls lazily on
 * first call (~6 MB). Returns `{ ok: true, reachable: true }` on
 * successful `SELECT 1`, throws otherwise.
 */
export async function probeDatabaseUrl({ timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const url = await getCredential("databaseUrl");
  if (!url) {
    throw new Error("DATABASE_URL is not configured.");
  }
  const r = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "docker",
      "run",
      "--rm",
      "-i",
      "-e",
      "PGCONNECT_TIMEOUT=10",
      "postgres:16-alpine",
      "psql",
      url,
      "-tAc",
      "select 1",
    ],
    { timeout: timeoutMs },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `Could not reach PostgreSQL: ${(r.stderr || r.stdout).trim() || "unknown error"}`,
    );
  }
  return { ok: true, reachable: true };
}

export const __testing = {
  IMAGE_BY_PROFILE,
  buildWslEnvForwarding,
  stageDbUrlFile,
};
