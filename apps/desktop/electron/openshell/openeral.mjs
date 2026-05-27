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
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCliInfo } from "./cli.mjs";
import { getCredential } from "./openeral-credentials.mjs";
import { DISTRO_NAME, toWslPath, wslRun, wslSpawn } from "./wsl.mjs";

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
 * Write `databaseUrl` to a Windows temp file and return its WSL mount path
 * (e.g. `/mnt/c/Users/.../AppData/Local/Temp/.ow-db-<uuid>`).
 *
 * WHY Windows-side rather than WSL bash:
 *   The openwork-openshell distro is minimal. We found that bash file I/O
 *   inside both node-pty PTY sessions AND wslRun piped sessions consistently
 *   fails with `bash: line 1: : No such file or directory` — /tmp may not
 *   be mounted on first boot, `mktemp` may be absent, and `$$`/redirect
 *   behaviour is unreliable in this specific distro build.
 *
 *   Creating the file on the Windows side (Node.js `fs.writeFile`) avoids
 *   WSL entirely. WSL exposes the Windows filesystem at /mnt/<drive>/...,
 *   so openshell's `--upload /mnt/c/.../file:/sandbox/db-url` works
 *   identically to a Linux-side path.
 *
 * @param {string} databaseUrl
 * @returns {Promise<string>} WSL-accessible path to the staged file
 */
export async function stageDbUrlFile(databaseUrl) {
  if (!databaseUrl) throw new Error("stageDbUrlFile: databaseUrl is required");
  const winPath = join(tmpdir(), `.ow-db-${randomUUID()}`);
  await writeFile(winPath, databaseUrl, { encoding: "utf8" });
  return toWslPath(winPath);
}

/**
 * Delete a file previously created by stageDbUrlFile. Silently ignores
 * ENOENT (already deleted by the bash trap inside the PTY).
 *
 * @param {string} wslPath  The path returned by stageDbUrlFile
 */
export async function removeDbUrlFile(wslPath) {
  // Convert the WSL mount path back to a Windows path so Node.js can unlink it.
  // Pattern: /mnt/<drive>/rest  →  <DRIVE>:\rest
  const m = wslPath?.match(/^\/mnt\/([a-z])\/(.+)$/);
  if (!m) return; // Not a /mnt/... path — nothing to do on the Windows side.
  const winPath = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  try {
    await unlink(winPath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn("[removeDbUrlFile] failed to delete staged credential file:", err.message);
    }
  }
}

/**
 * Parse the ANSI-colored text table output of `openshell sandbox list`
 * (no --json flag) and return the phase string for a specific sandbox name.
 * Returns null if the sandbox is not found or the format is unrecognised.
 *
 * Expected format (after ANSI stripping):
 *   NAME                            CREATED              PHASE
 *   my-sandbox                      2026-05-26 15:05:38  Ready
 *
 * openshell 0.0.42 does not support `--json` for `sandbox list`; the plain
 * text table is the only machine-readable output available.
 */
function parseListTextPhase(stdout, name) {
  // Strip ANSI SGR and erase codes (colours, bold, etc.)
  const clean = stdout.replace(/\x1B\[[0-9;]*[mK]/g, "");
  for (const line of clean.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(/\s+/);
    // First field must exactly match the sandbox name; this also skips the
    // header row (whose first field is "NAME").
    if (fields[0] !== name) continue;
    // Last whitespace-separated field is the phase (Ready/Provisioning/Error…).
    return fields[fields.length - 1].toLowerCase();
  }
  return null;
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
 * Poll `openshell sandbox list` until the named sandbox reports a Ready/running
 * phase, or until the timeout elapses.
 *
 * openshell 0.0.42 does NOT support `--json` for `sandbox list` (exits 0 but
 * outputs an error message) and has no `sandbox status` subcommand. We use the
 * plain text table output and parse the PHASE column via parseListTextPhase.
 * The JSON path via parseSandboxList is kept for future CLI versions that may
 * re-introduce JSON support.
 *
 * @param {string} name
 * @param {{ timeoutMs?: number, pollMs?: number, onProgress?: Function }} [opts]
 */
async function waitForSandboxReady(name, opts = {}) {
  const { timeoutMs = 120_000, pollMs = 4_000, onProgress } = opts;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  // Track the first time we see ANY non-Ready phase. This covers openshell
  // phases like "Provisioning", "Pulling", "Starting", "Downloading", and any
  // future phase string the CLI may emit. The old code only set this for
  // "Provisioning" and RESET it for everything else — so a sandbox that spent
  // >90 s in "Pulling" would have its stuck timer continuously reset and the
  // function would silently give up after 120 s with "connecting anyway".
  let firstNonReadyAt = null;
  const STUCK_THRESHOLD_MS = 90_000; // 90 s in any non-Ready state → stuck

  while (Date.now() < deadline) {
    attempt += 1;
    // 20 s outer timeout gives 10 s slack after bash's inner 10 s timer
    // fires, so wsl.exe has time to exit before wslRun's own timer does.
    // NOTE: do NOT pass --json — openshell 0.0.42 does not support that flag
    // for sandbox list and exits 0 with an error message, not usable data.
    let r;
    try {
      r = await wslRun(
        ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 10 openshell sandbox list 2>/dev/null"],
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
      let phase = null;

      // ── JSON path (future CLI versions that support --json) ──────────────
      const list = parseSandboxList(r.stdout);
      if (list) {
        const entry = list.find((s) => {
          if (typeof s === "string") return s === name;
          return s?.name === name || s?.sandbox_name === name || s?.id === name;
        });
        if (entry !== undefined && typeof entry !== "string") {
          phase = String(entry?.phase ?? entry?.status ?? entry?.state ?? "").toLowerCase() || null;
        }
        // Flat-string entries carry no phase info — fall through to text parse.
      }

      // ── Text table path (openshell 0.0.42, current version) ─────────────
      // parseListTextPhase strips ANSI codes and reads the PHASE column.
      if (phase === null) {
        phase = parseListTextPhase(r.stdout, name);
      }

      if (phase !== null) {
        if (/ready|running/i.test(phase)) return;
        if (/error|failed/i.test(phase)) {
          throw new Error(`Sandbox ${name} is in error state (${phase}). Delete it and reconnect.`);
        }
        // Any non-Ready, non-Error phase starts (or continues) the stuck timer.
        // We no longer distinguish "Provisioning" from "Pulling"/"Starting"/etc.
        // so a sandbox that stays in ANY non-ready phase for too long is caught.
        if (!firstNonReadyAt) firstNonReadyAt = Date.now();
        const stuckMs = Date.now() - firstNonReadyAt;
        if (stuckMs > STUCK_THRESHOLD_MS) {
          throw new Error(
            `STUCK_PROVISIONING: Sandbox "${name}" has not reached Ready state after ` +
              `${Math.round(stuckMs / 1000)}s (last observed phase: "${phase}"). ` +
              `Delete the sandbox and reconnect to create a fresh one. ` +
              `If the error persists, restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
          );
        }
        onProgress?.({ phase: "waiting", message: `Sandbox is ${phase} (attempt ${attempt}), waiting…` });
      } else {
        // Sandbox not yet visible in the list — keep polling.
        onProgress?.({ phase: "waiting", message: `Waiting for sandbox to appear (attempt ${attempt})…` });
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // Timed out without confirming Ready. If we ever saw a non-Ready phase,
  // treat the sandbox as stuck — connecting anyway would just fail with
  // "phase: Provisioning" in the PTY and confuse the user.
  if (firstNonReadyAt) {
    throw new Error(
      `STUCK_PROVISIONING: Sandbox "${name}" did not reach Ready state within ${Math.round(timeoutMs / 1000)}s. ` +
        `Delete the sandbox and reconnect to create a fresh one. ` +
        `If the error persists, restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
    );
  }
  // Sandbox was never visible in the list during polling — could be a very
  // slow gateway; proceed optimistically so the PTY can try to connect.
  onProgress?.({ phase: "timeout", message: "Sandbox did not appear in list; attempting to connect anyway." });
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
  //
  // NOTE: do NOT use --names or --json. openshell 0.0.42 does not support
  // either flag for sandbox list — both exit 0 but output an error message
  // rather than useful data. Use the plain text table output (same as
  // waitForSandboxReady and getSandboxPhaseOnce) and parse it with
  // parseListTextPhase, which strips ANSI codes and checks the NAME column.
  let r;
  try {
    r = await wslRun(
      ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 15 openshell sandbox list 2>/dev/null"],
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

  // Dual-parse strategy, same as waitForSandboxReady:
  //   1. Try JSON first (for future CLI versions that emit proper JSON).
  //   2. ALWAYS also try the text-table parser as a fallback.
  //
  // The original code used `if (!list)` which only fell back to text when
  // parseSandboxList returned null. But `!list` is false for an empty array
  // `[]`, so when openshell 0.0.42 emits a stale/empty JSON envelope the
  // text parser was silently skipped and sandboxExists returned false for
  // sandboxes that are clearly visible in the text table output.
  const list = parseSandboxList(r.stdout);
  if (list) {
    const found = list.some((s) => {
      if (typeof s === "string") return s === name;
      // Try every plausible name key the CLI might use
      return s?.name === name || s?.sandbox_name === name || s?.id === name;
    });
    if (found) return true;
    // JSON parsed but sandbox not in it — still try the text parser.
    // Some CLI builds output an empty JSON envelope alongside the text table.
  }
  // Text table path (openshell 0.0.42, current version). parseListTextPhase
  // strips ANSI codes and checks the NAME column exactly.
  return parseListTextPhase(r.stdout, name) !== null;
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
 * Single-poll snapshot of a sandbox's current phase string (lowercased).
 * Returns null when the sandbox is not found or the gateway is unreachable.
 * Used for a fast pre-flight state check — does NOT loop or wait.
 */
async function getSandboxPhaseOnce(name) {
  try {
    const r = await wslRun(
      ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 10 openshell sandbox list 2>/dev/null"],
      { timeout: 15_000 },
    );
    if (r.exitCode !== 0) return null;
    const list = parseSandboxList(r.stdout);
    if (list) {
      const entry = list.find((s) => {
        if (typeof s === "string") return s === name;
        return s?.name === name || s?.sandbox_name === name || s?.id === name;
      });
      if (entry !== undefined && typeof entry !== "string") {
        return String(entry?.phase ?? entry?.status ?? entry?.state ?? "").toLowerCase() || null;
      }
    }
    return parseListTextPhase(r.stdout, name);
  } catch {
    return null;
  }
}

/**
 * Pre-flight check before opening a PTY session to an OpenEral sandbox.
 *
 * WHY this no longer runs `openshell sandbox create` itself:
 *
 * The previous two-step pattern — (1) `create --no-tty -- /bin/true` via wslRun,
 * then (2) `sandbox exec --tty -- openeral` or `sandbox connect` via node-pty —
 * had an unfixable race:
 *
 *   • `create -- /bin/true` exits 0 the instant /bin/true exits (before the
 *     gateway finishes provisioning), so the sandbox is still "Provisioning"
 *     when step 2 tries to exec.
 *   • Polling `sandbox list` to detect Ready is unreliable: the gateway can be
 *     transiently unresponsive during container startup, unknown phase strings
 *     ("Pulling", "Starting") confused the regex, and even when "Ready" is
 *     observed there is a window before exec where the phase can regress.
 *
 * The canonical single-step pattern (per openeral-js/cli.test.ts) is:
 *
 *   openshell sandbox create --tty --name X --from Y \
 *     --upload /tmp/db-url:/sandbox/db-url \
 *     --provider claude --auto-providers -- openeral
 *
 * This blocks until Claude exits; provisioning + setup.sh + Claude Code all
 * happen inside one TTY-attached process — no window, no poll, no exec race.
 *
 * This function therefore only:
 *   1. Checks if the sandbox already exists (reconnect vs fresh-create).
 *   2. For stuck/errored existing sandboxes: auto-deletes so the PTY falls
 *      back to the single-step create path.
 *   3. Validates credentials and pre-pulls the Docker image.
 *
 * The caller (openeral-pty.mjs openSession) receives { existed } and picks
 * the right PTY command:
 *   existed=false → single-step `openshell sandbox create --tty ... -- openeral`
 *   existed=true  → `openshell sandbox connect NAME` (SSH/gRPC reconnect)
 *
 * @param {Object} opts
 * @param {string} opts.name
 * @param {"openeral-claude"|"openeral-openclaw"} opts.profile
 * @param {(evt: {phase: string, message: string}) => void} [opts.onProgress]
 * @param {boolean} [opts.skipImagePull]
 */
export async function createOpenEralSandbox(opts) {
  const { name, profile, onProgress, skipImagePull = false, _retryCount = 0 } = opts;
  if (!name) throw new Error("createOpenEralSandbox: name is required");
  if (!profile) throw new Error("createOpenEralSandbox: profile is required");

  const imageRef = imageForProfile(profile);

  // ── Reconnect path ─────────────────────────────────────────────────────────
  if (await sandboxExists(name)) {
    onProgress?.({ phase: "exists", message: `Sandbox ${name} found; checking state…` });
    const phase = await getSandboxPhaseOnce(name);

    if (phase === null || /ready|running/i.test(phase)) {
      // Ready or state unknown — proceed as reconnect (PTY will connect path).
      return { name, profile, imageRef, existed: true };
    }

    // Sandbox is in an unusable state (error, stuck provisioning, etc.).
    // Auto-delete it so the PTY falls through to the single-step create path.
    const stateDesc = /error|failed/i.test(phase)
      ? `in error state (${phase})`
      : `stuck in non-ready state (${phase})`;
    onProgress?.({
      phase: "recovery",
      message: `Sandbox ${stateDesc}. Auto-deleting and creating fresh…`,
    });
    try {
      await deleteOpenEralSandbox(name);
    } catch (deleteErr) {
      // Delete failed — try reconnect anyway; the connect may still succeed
      // or the PTY session error will be more informative than this one.
      console.warn(
        `[createOpenEralSandbox] auto-delete of ${stateDesc} sandbox failed (non-fatal):`,
        deleteErr.message,
      );
      return { name, profile, imageRef, existed: true };
    }
    // Sandbox deleted — fall through to pre-flight for fresh create below.
  }

  // ── Fresh-create pre-flight ─────────────────────────────────────────────────
  // Validate credentials. databaseUrl is staged as a temp file and uploaded
  // via --upload at create time. anthropicApiKey is forwarded via WSLENV so
  // --auto-providers can configure the claude provider without an interactive
  // prompt.
  const databaseUrl = await getCredential("databaseUrl");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured. Set it in Settings \u2192 Sandbox \u2192 OpenEral configuration.",
    );
  }
  const anthropicApiKey = await getCredential("anthropicApiKey");
  if (!anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured. Set it in Settings \u2192 Sandbox \u2192 OpenEral configuration.",
    );
  }

  // Pre-pull the image so the create command doesn't hit Docker Hub cold.
  // Uses a managed Docker config dir to avoid the credsStore:desktop issue.
  if (!skipImagePull) {
    onProgress?.({ phase: "pull", message: `Pulling ${imageRef}...` });
    await pullImage(imageRef, {
      onProgress: (text) => onProgress?.({ phase: "pull", message: text.trimEnd() }),
    });
  }

  // Stage DATABASE_URL as a Windows temp file accessible from WSL via /mnt/c/...
  // Node.js writes the file on the Windows side; WSL exposes it at the /mnt mount
  // point. This avoids bash file I/O inside the distro (mktemp/redirect proved
  // unreliable in the openwork-openshell minimal build).
  onProgress?.({ phase: "staging", message: "Staging credentials…" });
  const dbUrlWslPath = await stageDbUrlFile(databaseUrl);

  // alreadyExisted is set to true when create fails with "already exists". We
  // still call waitForSandboxReady in that case (the sandbox might still be
  // provisioning from a previous attempt) so the connect always has a Ready
  // sandbox to attach to. Using a flag rather than an early return keeps the
  // try/finally cleanup reliable.
  let alreadyExisted = false;
  try {
    onProgress?.({ phase: "creating", message: `Creating sandbox ${name}…` });

    // Inner timeout is 10 s shorter than wslRun's outer so bash kills openshell
    // first and wslRun sees exit 124 rather than throwing "wsl.exe timed out".
    const innerTimeoutS = Math.floor((DEFAULT_CREATE_TIMEOUT_MS - 10_000) / 1000);
    const uploadArg = `${dbUrlWslPath}:/sandbox/db-url`;
    const createCmd =
      `timeout ${innerTimeoutS} ` +
      `openshell sandbox create --no-tty ` +
      `--name ${shellQuote(name)} ` +
      `--from ${shellQuote(imageRef)} ` +
      `--upload ${shellQuote(uploadArg)} ` +
      `--provider claude --auto-providers ` +
      `-- /bin/true`;

    // Forward ANTHROPIC_API_KEY so --auto-providers configures the claude
    // provider at creation time without an interactive prompt.
    const createEnv = buildWslEnvForwarding({ ANTHROPIC_API_KEY: anthropicApiKey });

    let r;
    try {
      r = await wslRun(
        ["-d", DISTRO_NAME, "--", "bash", "-c", createCmd],
        { timeout: DEFAULT_CREATE_TIMEOUT_MS, env: createEnv },
      );
    } catch (err) {
      if (/wsl\.exe timed out/i.test(err?.message ?? "")) {
        throw new Error(
          "openshell sandbox create timed out. The OpenShell gateway may be unresponsive. " +
            "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
            "then try again.",
        );
      }
      throw err;
    }
    if (r.exitCode === 124) {
      throw new Error(
        `openshell sandbox create timed out (${innerTimeoutS}s). ` +
          "The OpenShell gateway may be unresponsive. " +
          "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway, " +
          "then try again.",
      );
    }
    if (r.exitCode !== 0) {
      const errText = (r.stderr || r.stdout).trim();
      // "already exists": sandboxExists returned false but the sandbox was
      // already registered with the gateway. Treat as reconnect and poll.
      if (/already exists/i.test(errText)) {
        console.warn(
          `[createOpenEralSandbox] sandbox ${name} already exists (detected at create time); treating as reconnect.`,
        );
        alreadyExisted = true;
      } else if (/stream closed|cancelled/i.test(errText)) {
        // openshell 0.0.42 sometimes closes the gRPC stream with
        // status=Cancelled after the gateway has already registered and
        // started provisioning the sandbox — even though the CLI exits 1.
        // Check immediately whether the sandbox appears in the list.
        console.warn(
          `[createOpenEralSandbox] create stream closed (exit ${r.exitCode}); checking if sandbox was registered…`,
        );
        const checkPhase = await getSandboxPhaseOnce(name);
        if (checkPhase !== null) {
          console.warn(
            `[createOpenEralSandbox] sandbox ${name} found after stream close (phase: ${checkPhase}); will poll for Ready.`,
          );
          alreadyExisted = true;
        } else {
          // Sandbox was not created — surface the error.
          throw new Error(
            `openshell sandbox create failed: gateway cancelled the stream and the sandbox was not registered. ` +
              `Wait a moment and retry, or restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health.`,
          );
        }
      } else {
        throw new Error(
          `openshell sandbox create failed (exit ${r.exitCode}): ` +
            `${errText || "(no output)"}`,
        );
      }
    }
  } finally {
    await removeDbUrlFile(dbUrlWslPath).catch(() => {});
  }

  // When the sandbox already existed (create said "already exists"), check its
  // phase before waiting. If it's stuck or errored from a previous attempt,
  // auto-delete it and start fresh so the user doesn't have to intervene.
  if (alreadyExisted) {
    const existingPhase = await getSandboxPhaseOnce(name);
    if (existingPhase !== null && !/ready|running/i.test(existingPhase)) {
      const stateDesc = /error|failed/i.test(existingPhase)
        ? `error state (${existingPhase})`
        : `non-ready state (${existingPhase})`;
      onProgress?.({
        phase: "recovery",
        message: `Existing sandbox is in ${stateDesc}; auto-deleting for fresh start…`,
      });
      if (_retryCount >= 2) {
        throw new Error(
          `Sandbox "${name}" could not be created after ${_retryCount} recovery attempt(s). ` +
            `Restart the OpenShell gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway and try again.`,
        );
      }
      try {
        await deleteOpenEralSandbox(name);
        // Give the gateway a moment to finish cleanup before we re-register
        // the same name. Without a small pause the fresh create can race the
        // gateway's own delete bookkeeping and get another "already exists".
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        // Deleted successfully — recurse to create a fresh sandbox.
        // skipImagePull=true because we already pulled the image above.
        return createOpenEralSandbox({
          name,
          profile,
          onProgress,
          skipImagePull: true,
          _retryCount: _retryCount + 1,
        });
      } catch (deleteErr) {
        console.warn(
          `[createOpenEralSandbox] auto-delete of ${stateDesc} sandbox failed (non-fatal):`,
          deleteErr.message,
        );
        // Delete failed — waitForSandboxReady below will surface a clear error.
      }
    }
  }

  // Poll until the sandbox reaches Ready state. The create command exits as
  // soon as /bin/true exits, which can be before the gateway finishes
  // provisioning the container. Also needed for the alreadyExisted path —
  // the sandbox might still be mid-provisioning from a prior attempt.
  onProgress?.({ phase: "waiting", message: "Waiting for sandbox to be ready…" });
  await waitForSandboxReady(name, {
    timeoutMs: 120_000,
    pollMs: 4_000,
    onProgress: (evt) => onProgress?.({ phase: evt.phase, message: evt.message }),
  });

  onProgress?.({ phase: "ready", message: `Sandbox ${name} is ready.` });
  return { name, profile, imageRef, existed: alreadyExisted };
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
