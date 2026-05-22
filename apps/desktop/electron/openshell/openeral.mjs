// OpenEral sandbox lifecycle. The upstream openeral maintainers'
// recipe runs everything (provision + Claude Code REPL) in one
// `openshell sandbox create --tty -- openeral` from an interactive
// shell. We can't do that headlessly: createOpenEralSandbox runs via
// wslRun (piped stdio, no TTY), so passing `-- openeral` as the
// trailing command would deadlock — Claude Code's first-run "Use this
// API key?" prompt has no terminal to read from, ssh eventually
// times out, sandbox create returns exit 1.
//
// Two-step shape we use instead:
//
//   1. `openshell sandbox create --no-tty ... -- /bin/true`
//      Provisions the container, uploads /sandbox/db-url, returns as
//      soon as /bin/true exits (≈ container-ready time).
//
//   2. `openshell sandbox exec <name> --tty -- openeral`
//      Spawned by openeral-pty.mjs (node-pty) or openeral-terminal.mjs
//      (external terminal emulator). Both give the wsl.exe child a
//      real PTY, so Claude Code's prompt is answerable on first run
//      and /home/agent persists the answer for re-connects.
//
// Other invariants:
//   - DATABASE_URL is staged as a FILE (one file, not a directory) in
//     the distro at /tmp/openeral-db-url-<uuid> and uploaded to
//     /sandbox/db-url. The openeral image's setup.sh reads it from
//     there at first `openeral` exec.
//   - ANTHROPIC_API_KEY rides in via env + WSLENV; --auto-providers
//     auto-creates the `claude` provider from it at create time.
//   - No --gateway flag: relies on the active selected gateway, which
//     the installer registers via `gateway add --local --name openshell`
//     and selects via `gateway select`.
//   - The rootfs MUST include openssh-client — openshell shells out
//     to ssh/scp for upload, connect, exec, download.

import { randomUUID } from "node:crypto";

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

// Docker pulls happen under user `banker` inside the distro. If Docker
// Desktop's WSL integration ever ran for this distro (or runs again on
// a future boot) it can write a `credsStore: "desktop"` line into
// ~/.docker/config.json that points at /mnt/c/.../docker-credential-desktop.exe.
// Linux docker can't exec a Windows binary — pulls then fail with
// `exec format error`. We route our docker invocations through an empty
// managed config dir so the credential helper is never invoked. The
// images we pull (openeral sandbox, postgres:16-alpine) are public, so
// skipping credentials is correct, not a workaround.
const DOCKER_CONFIG_DIR = "/tmp/openwork-docker-config";

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
    const child = wslSpawn([
      "-d",
      DISTRO_NAME,
      "--",
      "bash",
      "-c",
      `mkdir -p ${DOCKER_CONFIG_DIR} && exec docker --config ${DOCKER_CONFIG_DIR} pull ${shellQuote(imageRef)}`,
    ]);
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
 * Single-quote a string for safe embedding in a bash command.
 * Replaces any embedded ' with the standard `'\''` escape so the value
 * always rides as a single bash token even if it contains spaces or
 * shell metachars.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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

  // Forward credentials into the Linux side of WSL via WSLENV.
  // ANTHROPIC_API_KEY is always forwarded so --auto-providers can
  // auto-create the `claude` provider. For openclaw, also forward
  // OPENERAL_AGENT=openclaw so the openeral wrapper picks the right
  // agent at runtime.
  const forwarded = { ANTHROPIC_API_KEY: anthropicApiKey };
  if (profile === "openeral-openclaw") {
    forwarded.OPENERAL_AGENT = "openclaw";
  }
  const env = buildWslEnvForwarding(forwarded);

  // Staging the DATABASE_URL file AND running `openshell sandbox
  // create` happen in ONE bash session — two separate wsl.exe calls
  // can land in different /tmp namespaces on some banker distros, so
  // openshell would see ENOENT trying to upload a file that "existed"
  // from our staging call's perspective. One bash subshell keeps /tmp
  // consistent for both the cat write and the --upload read.
  //
  // We deliberately do NOT pass `-- openeral` as the trailing command:
  // `openshell sandbox create` BLOCKS until the trailing command exits,
  // but `openeral` launches Claude Code (an interactive REPL that
  // never exits), and we have no TTY here (wslRun is piped). That used
  // to deadlock until ssh timed out with `exit status 1`. Instead we
  // run `-- /bin/true` to provision the sandbox, return immediately,
  // and rely on `sandbox exec --tty -- openeral` from openeral-pty.mjs
  // / openeral-terminal.mjs to launch the REPL inside a real PTY.
  //
  // Note: openshell's --upload (and connect/exec/download) shells out
  // to `ssh`/`scp` locally. The rootfs Dockerfile MUST include
  // openssh-client or every sandbox operation fails with a cryptic
  // "Error: × No such file or directory (os error 2)" from the failed
  // exec.
  const dbPath = `/tmp/openeral-db-url-${randomUUID()}`;
  const script = [
    "set -e",
    "umask 077",
    `cat > ${dbPath}`,
    `chmod 600 ${dbPath}`,
    // trap cleans up the staging file whether sandbox create succeeds
    // or fails. EXIT fires once when the bash subshell exits.
    `trap 'rm -f ${dbPath}' EXIT`,
    `exec openshell sandbox create --no-tty ` +
      `--name ${shellQuote(name)} ` +
      `--from ${shellQuote(imageRef)} ` +
      `--upload ${dbPath}:/sandbox/db-url ` +
      `--provider claude --auto-providers ` +
      `-- /bin/true`,
  ].join("\n");

  onProgress?.({ phase: "create", message: `Creating sandbox ${name}...` });
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-c", script],
    {
      timeout: opts.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS,
      env,
      stdin: databaseUrl,
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
  // Same DOCKER_CONFIG sidestep as pullImage — postgres:16-alpine is
  // public and we don't want Docker Desktop's credential helper in the
  // path here either.
  const r = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "bash",
      "-c",
      `mkdir -p ${DOCKER_CONFIG_DIR} && exec docker --config ${DOCKER_CONFIG_DIR} run --rm -i -e PGCONNECT_TIMEOUT=10 postgres:16-alpine psql ${shellQuote(url)} -tAc 'select 1'`,
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
  shellQuote,
};
