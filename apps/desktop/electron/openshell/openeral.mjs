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
 * Parse the raw openshell sandbox list output into a normalised array.
 * Returns null when the JSON is unparseable or the shape is unrecognised.
 * Each item is either a plain string (name only) or an object that may
 * carry phase/status fields depending on the CLI version.
 */
function parseSandboxList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.sandboxes)
      ? parsed.sandboxes
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.data)
          ? parsed.data
          : null;
  return list;
}

/**
 * Poll `openshell sandbox list --json` until the named sandbox reports
 * a Ready/running phase, or until the timeout elapses. If the CLI does
 * not include phase information in the list (flat string arrays), we
 * optimistically assume the sandbox is ready and return immediately.
 *
 * @param {string} name
 * @param {{ timeoutMs?: number, pollMs?: number, onProgress?: Function }} [opts]
 */
async function waitForSandboxReady(name, opts = {}) {
  const { timeoutMs = 120_000, pollMs = 4_000, onProgress } = opts;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let flatStringStreak = 0; // consecutive polls returning flat-string (no phase info)
  while (Date.now() < deadline) {
    attempt += 1;
    const r = await wslRun(
      ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 10 openshell sandbox list --json"],
      { timeout: 15_000 },
    );
    if (r.exitCode === 0) {
      const list = parseSandboxList(r.stdout);
      if (list) {
        const entry = list.find((s) => {
          if (typeof s === "string") return s === name;
          return s?.name === name || s?.sandbox_name === name || s?.id === name;
        });
        if (entry !== undefined) {
          if (typeof entry === "string") {
            // Flat string — CLI doesn't include phase info in this build.
            // Wait for 2 consecutive flat-string polls before assuming ready,
            // so we don't connect to a sandbox that just registered but hasn't
            // finished provisioning (the gateway takes a moment to write phase
            // info after initial registration).
            flatStringStreak += 1;
            if (flatStringStreak >= 2) return; // assume ready
            onProgress?.({ phase: "waiting", message: `Sandbox ${name} registered; confirming Ready state…` });
          } else {
            flatStringStreak = 0;
            const phase = String(entry?.phase ?? entry?.status ?? entry?.state ?? "").toLowerCase();
            if (!phase || /ready|running/i.test(phase)) return;
            if (/error|failed/i.test(phase)) {
              throw new Error(`Sandbox ${name} is in error state (${phase}). Delete it and reconnect.`);
            }
            onProgress?.({ phase: "waiting", message: `Sandbox is ${phase} (attempt ${attempt}), waiting… (this can take a few minutes on first run)` });
          }
        }
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // Timed out — proceed anyway; exec may succeed if setup.sh just finished.
  onProgress?.({ phase: "timeout", message: "Sandbox is taking longer than expected. Attempting to connect anyway…" });
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
  // Wrap with bash timeout so the openshell CLI is force-killed after
  // 15 s if the gateway is unreachable. Without this wrapper the
  // process hangs until wslRun's full timeout fires — making the UI
  // appear frozen. bash exits 124 when it kills the child.
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 15 openshell sandbox list --json"],
    { timeout: 20_000 },
  );
  if (r.exitCode === 124) {
    throw new Error(
      "OpenShell gateway is not responding (openshell sandbox list timed out). " +
        "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
        "then try again.",
    );
  }
  if (r.exitCode !== 0) return false;
  const list = parseSandboxList(r.stdout);
  if (!list) {
    console.warn("[sandboxExists] unrecognised sandbox list shape:", r.stdout.slice(0, 200));
    return false;
  }
  return list.some((s) => {
    if (typeof s === "string") return s === name;
    // Try every plausible name key the CLI might use
    return s?.name === name || s?.sandbox_name === name || s?.id === name;
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
  // Wait for it to reach Ready state before returning so the subsequent
  // PTY exec doesn't fail with "phase: Provisioning".
  if (await sandboxExists(name)) {
    onProgress?.({ phase: "exists", message: `Sandbox ${name} already exists; waiting for it to be ready…` });
    await waitForSandboxReady(name, {
      onProgress: (evt) => onProgress?.({ phase: evt.phase, message: evt.message }),
    });
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
  const stringcostApiKey = await getCredential("stringcostApiKey");
  const forwarded = { ANTHROPIC_API_KEY: anthropicApiKey };
  if (stringcostApiKey) {
    forwarded.STRINGCOST_API_KEY = stringcostApiKey;
  }
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
  // Keep the create command simple — use `-- /bin/true` so openshell
  // returns as soon as provisioning is done (no trailing command to race
  // against the --auto-providers setup).
  //
  // openshell CLI 0.0.42 has a race: when --auto-providers is combined
  // with a non-trivial `-- CMD`, the provider finalisation and the CMD
  // exec both touch the gateway concurrently and one of them returns
  // gRPC NotFound, aborting the create with exit 1.  Using `-- /bin/true`
  // (exits in ~0 ms) avoids the window where the race can manifest.
  //
  // ANTHROPIC_API_KEY delivery for setup.sh's StringCost presign step:
  // we write /sandbox/anthropic-api-key via a separate `sandbox exec`
  // call AFTER create, so there is no quoting complexity inside the
  // create command.  setup.sh falls back gracefully if the exec fails
  // (it skips the presign step when ANTHROPIC_API_KEY is a placeholder).
  const script = [
    "set -e",
    "umask 077",
    // DATABASE_URL is piped via stdin — never touches the command line.
    `cat > ${dbPath}`,
    `chmod 600 ${dbPath}`,
    // Staging file is removed on exit whether create succeeds or fails.
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
    const output = (r.stderr || r.stdout).trim();
    // openshell exits 1 with "already exists" when sandboxExists() returned
    // a false-negative (e.g. unexpected JSON shape from sandbox list). Treat
    // this as a successful reconnect instead of a hard failure.
    if (/already exists/i.test(output)) {
      onProgress?.({ phase: "exists", message: `Sandbox ${name} already exists; reconnecting.` });
      return { name, profile, imageRef, existed: true };
    }
    // openshell CLI 0.0.42 race: the gRPC stream sometimes closes with
    // "NotFound: sandbox not found" even though the gateway already registered
    // the sandbox and started provisioning it. Check the list before treating
    // this as a hard failure — if the sandbox is there, wait for Ready.
    if (/not.?found|sandbox not found/i.test(output)) {
      const checkExists = await sandboxExists(name).catch(() => false);
      if (checkExists) {
        console.warn(
          `[createOpenEralSandbox] create exited 1 with NotFound but sandbox ${name} found in list; treating as provisioning.`,
        );
        onProgress?.({ phase: "waiting", message: `Sandbox ${name} is provisioning; waiting for Ready state…` });
        await waitForSandboxReady(name, {
          timeoutMs: 5 * 60_000,
          onProgress: (evt) => onProgress?.({ phase: evt.phase, message: evt.message }),
        });
        return { name, profile, imageRef, existed: false };
      }
    }
    const cli = await getCliInfo().catch(() => null);
    const versionTag = cli?.version ? ` [CLI ${cli.version}]` : "";
    throw new Error(
      `openshell sandbox create failed (exit ${r.exitCode})${versionTag}: ` +
        `${output || "(no output)"}`,
    );
  }
  // Write the API key file so setup.sh can create a StringCost presign
  // with the real key (not the openshell:resolve:env:* placeholder).
  // This runs as a separate exec AFTER create so there is no interaction
  // with --auto-providers.  Non-fatal: if the exec fails, setup.sh
  // skips the presign step and uses the placeholder / env-var fallback.
  const writeKeyScript =
    `openshell sandbox exec --name ${shellQuote(name)} -- ` +
    `sh -c ${shellQuote(`mkdir -p /sandbox && printf %s ${shellQuote(anthropicApiKey)} > /sandbox/anthropic-api-key && chmod 600 /sandbox/anthropic-api-key`)}`;
  await wslRun(["-d", DISTRO_NAME, "--", "bash", "-c", writeKeyScript], {
    timeout: 30_000,
    env,
  }).catch((e) => {
    // Non-fatal — setup.sh has an explicit fallback for missing key file.
    console.warn("[createOpenEralSandbox] key-file write via exec failed (non-fatal):", e.message);
  });

  // Wait for the sandbox to reach Ready before returning. `sandbox create
  // -- /bin/true` exits 0 as soon as the gateway REGISTERS the sandbox,
  // but setup.sh inside the container may still be running. If the PTY
  // exec starts while still Provisioning, openshell returns "not ready"
  // and the terminal shows [Session ended (exit 1)] immediately.
  // Use a 5-minute timeout — Docker image pull + container start can take
  // several minutes on the first run or on a slow connection.
  onProgress?.({ phase: "waiting", message: `Sandbox ${name} created; waiting for Ready state…` });
  await waitForSandboxReady(name, {
    timeoutMs: 5 * 60_000,
    onProgress: (evt) => onProgress?.({ phase: evt.phase, message: evt.message }),
  });
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
