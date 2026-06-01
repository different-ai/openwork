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
 * Returns null only when the raw text cannot yield any sandbox list at all.
 *
 * The openshell CLI has emitted several JSON shapes across releases:
 *   - Flat array:                  [...sandbox objects...]
 *   - {sandboxes: [...]}           early releases
 *   - {items: [...]}               v0.0.3x
 *   - {data: [...]}                v0.0.4x
 *   - {results: [...]}             some builds
 *   - {page: ..., items: [...]}    paginated response
 *
 * If none of the known envelope keys match, we fall back to the FIRST
 * Array-valued key found in the object, so future CLI versions with a
 * new envelope key still work without a code change.
 *
 * Each item is either a plain string (name only) or an object that may
 * carry phase/status fields depending on the CLI version.
 */
function parseSandboxList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not valid JSON at all — caller falls back to text search.
    return null;
  }

  // Flat array
  if (Array.isArray(parsed)) return parsed;

  if (parsed && typeof parsed === "object") {
    // Known envelope keys (add new ones here as the CLI evolves)
    for (const key of ["sandboxes", "items", "data", "results", "namespaces"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    // Generic fallback: return the first array value found
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key])) {
        console.warn(`[parseSandboxList] using unknown envelope key "${key}"`);
        return parsed[key];
      }
    }
  }

  return null;
}

/**
 * Parse `openshell sandbox list` (plain-text table, no --json flag) to
 * find the PHASE of a specific sandbox. Returns null when the sandbox is
 * absent from the output or the phase column cannot be located.
 *
 * CLI 0.0.42 does NOT support `--json` for `sandbox list` — it exits 0
 * but writes "unexpected argument '--json' found" to stdout. This helper
 * uses the ANSI text table that plain `sandbox list` emits instead.
 *
 * Typical table format (with optional ANSI colour codes):
 *   NAME                               CREATED        PHASE
 *   openeral-test-workspace23edf4545   2 minutes ago  Provisioning
 */
function parseListTextPhase(stdout, sandboxName) {
  // Strip ANSI escape sequences (colour, bold, cursor-movement codes).
  const clean = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const lines = clean.split(/\r?\n/);

  // Locate the header row to find the column offset of PHASE.
  let phaseOffset = -1;
  for (const line of lines) {
    const up = line.toUpperCase();
    if (up.includes("NAME") && up.includes("PHASE")) {
      phaseOffset = up.indexOf("PHASE");
      break;
    }
  }

  // Scan every row for the sandbox name.
  for (const line of lines) {
    if (!line.includes(sandboxName)) continue;

    // Use the column offset when the header was found.
    if (phaseOffset >= 0 && line.length > phaseOffset) {
      const phase = line.slice(phaseOffset).trim().split(/\s+/)[0];
      if (phase) return phase;
    }

    // Fallback: split on 2+ consecutive spaces and take the last token
    // (works for table formats where there is no fixed column alignment).
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1].trim();
      if (last) return last;
    }
  }

  return null;
}

/**
 * Poll `openshell sandbox list` until the named sandbox reports a
 * Ready/running phase, or until the timeout elapses.
 *
 * @param {string} name
 * @param {{ timeoutMs?: number, pollMs?: number, onProgress?: Function }} [opts]
 */
async function waitForSandboxReady(name, opts = {}) {
  const { timeoutMs = 120_000, pollMs = 4_000, onProgress } = opts;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  // Track the first time we see a "Provisioning" phase so we can detect
  // sandboxes that are stuck (never transition to Ready).
  let firstProvisioningAt = null;
  const STUCK_PROVISIONING_THRESHOLD_MS = 90_000; // 90 s in Provisioning → stuck

  while (Date.now() < deadline) {
    attempt += 1;
    // 20 s outer timeout gives 10 s slack after bash's inner 10 s timer
    // fires, so wsl.exe has time to exit before wslRun's own timer does.
    let r;
    try {
      // Use plain `sandbox list` (no --json). CLI 0.0.42 does not support
      // --json for this subcommand — it exits 0 but writes an error string
      // to stdout, causing parseSandboxList to return null every time.
      // parseListTextPhase reads the phase directly from the ANSI text table.
      r = await wslRun(
        ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 10 openshell sandbox list"],
        { timeout: 20_000 },
      );
    } catch {
      // Gateway unreachable during polling — report progress and keep
      // waiting; the sandbox may still transition to Ready.
      onProgress?.({ phase: "waiting", message: `Gateway unresponsive (attempt ${attempt}), retrying…` });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (r.exitCode === 0) {
      const phase = parseListTextPhase(r.stdout, name)?.toLowerCase() ?? null;
      if (phase !== null) {
        // Sandbox is visible in the list — check its phase.
        if (!phase || /ready|running/i.test(phase)) return;
        if (/error|failed/i.test(phase)) {
          throw new Error(`Sandbox ${name} is in error state (${phase}). Delete it and reconnect.`);
        }
        // Detect sandboxes stuck in Provisioning. If the sandbox has been
        // in a provisioning-like state for longer than the threshold, bail
        // out early with a clear error so the renderer can offer a
        // "Delete and start fresh" action rather than spinning forever.
        if (/provision/i.test(phase)) {
          if (!firstProvisioningAt) firstProvisioningAt = Date.now();
          const stuckMs = Date.now() - firstProvisioningAt;
          if (stuckMs > STUCK_PROVISIONING_THRESHOLD_MS) {
            throw new Error(
              `STUCK_PROVISIONING: Sandbox "${name}" has been in "${phase}" state for ` +
                `over ${Math.round(stuckMs / 1000)}s and appears stuck. ` +
                `Delete the sandbox and reconnect to create a fresh one. ` +
                `If the error persists, restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
            );
          }
        } else {
          // Phase changed away from Provisioning — reset the timer.
          firstProvisioningAt = null;
        }
        onProgress?.({ phase: "waiting", message: `Sandbox is ${phase} (attempt ${attempt}), waiting…` });
      }
      // phase === null → sandbox not yet visible in the list, keep polling.
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // Timed out without confirming Ready — if we last saw a provisioning phase
  // treat it as stuck rather than proceeding optimistically (the exec would
  // fail anyway with "phase: Provisioning").
  if (firstProvisioningAt) {
    throw new Error(
      `STUCK_PROVISIONING: Sandbox "${name}" did not reach Ready state within ${Math.round(timeoutMs / 1000)}s ` +
        `(last observed phase: Provisioning). ` +
        `Delete the sandbox and reconnect to create a fresh one. ` +
        `If the error persists, restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
    );
  }
  // Non-provisioning timeout — proceed; exec may succeed if setup.sh just finished.
  onProgress?.({ phase: "timeout", message: "Sandbox did not confirm Ready state; attempting to connect anyway." });
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
  //
  // wslRun timeout is set to 25 s (10 s slack after bash's 15 s fires).
  // Without the extra slack wsl.exe can outlive the bash timeout and
  // trigger wslRun's own timer — throwing a raw "wsl.exe timed out"
  // error before the exitCode === 124 check below is ever reached.
  // CLI 0.0.42 does NOT support `--json` for `sandbox list` — it exits 0
  // but writes "unexpected argument '--json' found" to stdout, which causes
  // parseSandboxList to return null and the fallback text-includes check to
  // miss the sandbox name (the error message doesn't contain it).
  // `--names` outputs one sandbox name per line and is supported in 0.0.42.
  let r;
  try {
    r = await wslRun(
      ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 15 openshell sandbox list --names"],
      { timeout: 25_000 },
    );
  } catch (err) {
    // wslRun throws (never returns r) when its own timer fires.
    // Map any timeout to the user-friendly gateway message so the
    // renderer can show a clear call-to-action instead of a raw stack.
    throw new Error(
      "OpenShell gateway is not responding (sandbox list timed out). " +
        "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
        "then try again.",
    );
  }
  if (r.exitCode === 124) {
    throw new Error(
      "OpenShell gateway is not responding (openshell sandbox list timed out). " +
        "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
        "then try again.",
    );
  }
  if (r.exitCode !== 0) return false;
  // --names outputs one sandbox name per line (no JSON).
  const names = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (names.includes(name)) return true;
  // Fallback: if --names flag is not supported by a future CLI version and the
  // output falls back to a text/JSON format, check whether the raw output
  // contains the sandbox name anywhere (conservative — avoids a spurious create).
  if (names.length === 0 && r.stdout.includes(name)) {
    console.warn(`[sandboxExists] --names may be unsupported; found "${name}" via text search.`);
    return true;
  }
  return false;
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
  // NOTE: do NOT use `exec openshell sandbox create ...` here.
  // `exec` replaces the bash process, which means the EXIT trap set
  // below never fires and the temp DB-URL file leaks in /tmp forever.
  // Running openshell as a regular child (no exec) lets bash honour
  // the trap on exit — whether the create succeeds or fails.
  const script = [
    "set -e",
    "umask 077",
    // DATABASE_URL is piped via stdin — never touches the command line.
    `cat > ${dbPath}`,
    `chmod 600 ${dbPath}`,
    // Staging file is removed on exit whether create succeeds or fails.
    `trap 'rm -f ${dbPath}' EXIT`,
    `openshell sandbox create --no-tty ` +
      `--name ${shellQuote(name)} ` +
      `--from ${shellQuote(imageRef)} ` +
      `--upload ${dbPath}:/sandbox/db-url ` +
      `--provider claude --auto-providers ` +
      `-- /bin/true`,
  ].join("\n");

  onProgress?.({ phase: "create", message: `Creating sandbox ${name}…` });
  let r;
  try {
    r = await wslRun(
      ["-d", DISTRO_NAME, "--", "bash", "-c", script],
      {
        timeout: opts.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS,
        env,
        stdin: databaseUrl,
      },
    );
  } catch (err) {
    if (/wsl\.exe timed out/i.test(err?.message ?? "")) {
      throw new Error(
        `openshell sandbox create timed out after 3 minutes. ` +
          `The OpenShell gateway or Docker daemon is not responding. ` +
          `Open Settings \u2192 Sandbox \u2192 OpenShell health and click Restart Gateway, then retry.`,
      );
    }
    throw err;
  }
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
    // the sandbox and started provisioning. Check the list before treating
    // this as a hard failure — if the sandbox is there, wait for Ready.
    if (/not.?found|sandbox not found/i.test(output)) {
      const checkExists = await sandboxExists(name).catch(() => false);
      if (checkExists) {
        console.warn(
          `[createOpenEralSandbox] create exited 1 with NotFound but ${name} found in list; treating as provisioning.`,
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

  // `sandbox create -- /bin/true` exits 0 as soon as the gateway REGISTERS
  // the sandbox, but setup.sh inside the container may still be running.
  // Wait for Ready before returning so the PTY never connects to a
  // still-Provisioning sandbox. Uses a 5-minute timeout; the 90-second
  // stuck-Provisioning detection inside waitForSandboxReady will fire and
  // show the "Delete & start fresh" button if the gateway is truly stuck.
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
  // `openshell sandbox delete` does NOT support --force; passing it causes
  // "unexpected argument '--force' found" and exit 1. Use bash timeout for
  // the same inner-timeout safety net we apply to list/create calls.
  let r;
  try {
    r = await wslRun(
      ["-d", DISTRO_NAME, "--", "bash", "-c", `timeout 20 openshell sandbox delete ${shellQuote(name)}`],
      { timeout: 30_000 },
    );
  } catch (err) {
    if (/wsl\.exe timed out/i.test(err?.message ?? "")) {
      throw new Error(
        "openshell sandbox delete timed out. The OpenShell gateway may be unresponsive. " +
          "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
          "then try again.",
      );
    }
    throw err;
  }
  if (r.exitCode !== 0) {
    const output = (r.stderr || r.stdout).trim();
    // 124 = bash timeout(1) hit the inner timer — gateway is unresponsive.
    if (r.exitCode === 124) {
      throw new Error(
        "openshell sandbox delete timed out (gateway unresponsive). " +
          "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
          "then try again.",
      );
    }
    throw new Error(`openshell sandbox delete failed: ${output || "(no output)"}`);
  }
  return r;
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
