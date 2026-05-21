// OpenEral sandbox lifecycle. Everything below assumes:
//   - The openwork-openshell WSL distro is registered and healthy
//     (Phase 1–6 installer brings that up).
//   - The user has configured at least DATABASE_URL via
//     openeral-credentials.mjs; ANTHROPIC_API_KEY is additionally
//     required for the OpenClaw profile.
//
// What OpenEral expects on `openshell sandbox create`:
//   1. The image at ghcr.io/sandys/openeral/... or
//      ghcr.io/pavitra-programmers/openeral/... — different forks per agent.
//   2. A `--upload <localDir>:/sandbox/openeral-input` directory that
//      contains `db-url`, optional `anthropic-api-key`, optional
//      `presign.json` files. setup.sh inside the image reads these.
//   3. `--provider claude --auto-providers` (claude is built-in) or
//      `--provider openclaw --auto-providers` (we create the openclaw
//      provider idempotently before sandbox-create).
//   4. The literal command `openeral` — a /usr/local/bin shim that
//      execs setup.sh.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCliInfo } from "./cli.mjs";
import { getCredential } from "./openeral-credentials.mjs";
import { DISTRO_NAME, toWslPath, wslRun, wslSpawn } from "./wsl.mjs";

const IMAGE_BY_PROFILE = {
  "openeral-claude": "ghcr.io/sandys/openeral/sandbox:just-bash",
  "openeral-openclaw": "ghcr.io/pavitra-programmers/openeral/sandbox:just-bash",
};

// Maps a profile to the `--provider` value passed to `openshell sandbox create`.
// "claude" is built into OpenShell; "openclaw" we create idempotently below.
const PROVIDER_BY_PROFILE = {
  "openeral-claude": "claude",
  "openeral-openclaw": "openclaw",
};

const DEFAULT_PULL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CREATE_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export function imageForProfile(profile) {
  const img = IMAGE_BY_PROFILE[profile];
  if (!img) throw new Error(`Unknown OpenEral profile: ${profile}`);
  return img;
}

export function providerForProfile(profile) {
  const provider = PROVIDER_BY_PROFILE[profile];
  if (!provider) throw new Error(`Unknown OpenEral profile: ${profile}`);
  return provider;
}

/**
 * Idempotently make sure the `openclaw` provider exists. Claude is the
 * built-in default and needs no provider registration. Returns:
 *   { created: true }   on first create
 *   { created: false }  if it existed and we updated (or it was already current)
 */
export async function ensureOpenClawProvider() {
  const credentialFlag = "OPENERAL_AGENT=openclaw";
  const create = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "openshell",
      "provider",
      "create",
      "--name",
      "openclaw",
      "--type",
      "generic",
      "--credential",
      credentialFlag,
    ],
    { timeout: 30_000 },
  );
  if (create.exitCode === 0) return { created: true };
  // Likely already exists. Try update.
  const update = await wslRun(
    [
      "-d",
      DISTRO_NAME,
      "--",
      "openshell",
      "provider",
      "update",
      "openclaw",
      "--credential",
      credentialFlag,
    ],
    { timeout: 30_000 },
  );
  if (update.exitCode === 0) return { created: false };
  throw new Error(
    `Could not ensure openclaw provider: ` +
      `create exit=${create.exitCode} stderr=${create.stderr.trim()}, ` +
      `update exit=${update.exitCode} stderr=${update.stderr.trim()}`,
  );
}

/**
 * Pull the OpenEral image into the distro's Docker. Streamed via
 * wslSpawn so a long-running pull shows incremental progress.
 *
 * onProgress receives raw docker-pull lines verbatim (Pulling fs layer,
 * Extracting, etc.); caller decides how to render them.
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
 * createOpenEralSandbox when re-opening a workspace whose Postgres-backed
 * /home/agent should restore from the existing sandbox.
 *
 * Tolerates both the flat-array (`[...]`) and envelope (`{sandboxes:[...]}`,
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
 * Stage a temp directory on the host with the credential files OpenEral's
 * setup.sh reads from /sandbox/openeral-input/. Returns the host path
 * plus a cleanup() that wipes it. The caller is responsible for invoking
 * cleanup AFTER `openshell sandbox create` has copied the files inward.
 */
async function stageCredentialBundle({ profile }) {
  const databaseUrl = await getCredential("databaseUrl");
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured. Set it in Settings → Sandbox → OpenEral configuration.",
    );
  }
  const anthropicApiKey = await getCredential("anthropicApiKey");
  if (profile === "openeral-openclaw" && !anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for OpenClaw (its embedded gateway can't resolve " +
        "OpenShell provider placeholders). Set it in Settings → Sandbox → OpenEral configuration.",
    );
  }

  const hostDir = await mkdtemp(path.join(os.tmpdir(), "openeral-input-"));
  try {
    await writeFile(path.join(hostDir, "db-url"), databaseUrl, { mode: 0o600 });
    if (anthropicApiKey) {
      await writeFile(path.join(hostDir, "anthropic-api-key"), anthropicApiKey, {
        mode: 0o600,
      });
    }
    // STRINGCOST presign is intentionally not staged here — the README's
    // flow creates it via a curl call against app.stringcost.com which
    // needs a separate IPC handler we don't have yet. Phase O8 follow-up.
  } catch (err) {
    await rm(hostDir, { recursive: true, force: true });
    throw err;
  }
  return {
    hostDir,
    cleanup: async () => {
      try {
        await rm(hostDir, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    },
  };
}

/**
 * Create (or resume into) an OpenEral sandbox. Sandbox naming is stable
 * per-workspace — re-running with the same name on the same Postgres
 * is OpenEral's whole portability story.
 *
 * Returns { name, profile, imageRef, provider, existed }. `existed === true`
 * means we short-circuited because the sandbox was already up; the caller
 * skips straight to connect.
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
  const provider = providerForProfile(profile);

  // Short-circuit if the sandbox already exists (workspace reopen).
  if (await sandboxExists(name)) {
    onProgress?.({ phase: "exists", message: `Sandbox ${name} already exists; reconnecting.` });
    return { name, profile, imageRef, provider, existed: true };
  }

  if (profile === "openeral-openclaw") {
    onProgress?.({ phase: "provider", message: "Ensuring openclaw provider exists..." });
    await ensureOpenClawProvider();
  }

  if (!skipImagePull) {
    onProgress?.({ phase: "pull", message: `Pulling ${imageRef}...` });
    await pullImage(imageRef, {
      onProgress: (text) => onProgress?.({ phase: "pull", message: text.trimEnd() }),
    });
  }

  onProgress?.({ phase: "stage", message: "Staging credential bundle..." });
  const bundle = await stageCredentialBundle({ profile });

  try {
    const wslUploadDir = toWslPath(bundle.hostDir);
    onProgress?.({ phase: "create", message: `Creating sandbox ${name}...` });
    const r = await wslRun(
      [
        "-d",
        DISTRO_NAME,
        "--",
        "openshell",
        "sandbox",
        "create",
        "--name",
        name,
        "--from",
        imageRef,
        "--upload",
        `${wslUploadDir}:/sandbox/openeral-input`,
        "--provider",
        provider,
        "--auto-providers",
        "--detach",
        "--",
        "openeral",
      ],
      { timeout: opts.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS },
    );
    if (r.exitCode !== 0) {
      // Include the CLI version in the error — flag-shape drift is the
      // dominant cause here, so the next bug report tells us which
      // version we're dealing with without another round-trip.
      const cli = await getCliInfo().catch(() => null);
      const versionTag = cli?.version ? ` [CLI ${cli.version}]` : "";
      throw new Error(
        `openshell sandbox create failed (exit ${r.exitCode})${versionTag}: ` +
          `${(r.stderr || r.stdout).trim() || "(no output)"}`,
      );
    }
    onProgress?.({ phase: "ready", message: `Sandbox ${name} ready.` });
    return { name, profile, imageRef, provider, existed: false };
  } finally {
    await bundle.cleanup();
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
 *
 * Replaces the openeralTestDatabase stub in main.mjs.
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
  PROVIDER_BY_PROFILE,
  stageCredentialBundle,
};
