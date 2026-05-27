// PTY bridge for OpenEral sessions. Spawns the platform-correct
// `openshell sandbox connect <name>` command inside a real pseudo-
// terminal (node-pty) so Claude Code and OpenClaw — which both refuse
// to launch without a TTY — get a working stdin/stdout/resize channel.
//
// The bytes flow:
//
//   renderer xterm.js ──IPC── main process ──node-pty.write── wsl.exe ──
//     openshell sandbox connect <name> ── docker exec ── Claude Code TUI
//
//   …and back the other way.
//
// One module-level `sessions` Map tracks every open PTY by a fresh
// session id (UUID). The renderer holds the id; main owns the IPty
// handle. Closing the renderer-side terminal calls back here to clean
// up the IPty (kill the wsl child) without removing the sandbox itself
// — that's OpenEral's persistence story.
//
// node-pty is lazy-loaded inside spawnSession() so this module can be
// imported under `node --test` (the test suite stubs out spawnSession
// via __testing.installSpawnImpl).

import { randomUUID } from "node:crypto";

import { DISTRO_NAME } from "./wsl.mjs";

/** @typedef {(data: string | Uint8Array) => void} DataHandler */
/** @typedef {(exitCode: number | null, signal?: string | null) => void} ExitHandler */

/**
 * @typedef {Object} IPtyLike
 * @property {(data: string) => void} write
 * @property {(cols: number, rows: number) => void} resize
 * @property {(signal?: string) => void} kill
 * @property {(handler: DataHandler) => { dispose: () => void }} onData
 * @property {(handler: (event: { exitCode: number; signal?: number | undefined }) => void) => { dispose: () => void }} onExit
 * @property {number | undefined} pid
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} sandboxName
 * @property {IPtyLike} pty
 * @property {DataHandler | null} onData
 * @property {ExitHandler | null} onExit
 * @property {{ cols: number; rows: number }} size
 * @property {number} openedAt
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * Default spawn implementation: lazy-loads node-pty and spawns wsl.exe
 * with the openshell sandbox connect command. Overridable via
 * __testing.installSpawnImpl for the unit suite.
 *
 * @param {{ sandboxName: string; cols: number; rows: number }} opts
 * @returns {Promise<IPtyLike>}
 */

/**
 * Build a WSL-forwarded env object. Any keys in `extra` are added to
 * the Electron process.env AND appended to WSLENV so wsl.exe passes
 * them through to the distro (and from there into the sandbox container
 * via openshell's exec). Without WSLENV, Windows env vars are stripped
 * by wsl.exe before the linux process sees them.
 *
 * @param {Record<string, string>} extra
 * @returns {Record<string, string>}
 */
function buildWslEnv(extra) {
  const names = Object.keys(extra).filter((k) => extra[k]);
  if (names.length === 0) return process.env;
  const existing = process.env.WSLENV ? process.env.WSLENV.split(":") : [];
  const merged = Array.from(new Set([...existing, ...names]));
  return {
    ...process.env,
    ...Object.fromEntries(names.map((k) => [k, extra[k]])),
    WSLENV: merged.join(":"),
  };
}

let spawnImpl = async ({ sandboxName, cols, rows, extraEnv }) => {
  const pty = await import("node-pty");
  const quotedName = `'${sandboxName.replace(/'/g, "'\\''")}'`;

  // WHY gRPC exec breaks interactive TUIs (Claude Code theme selector, etc.)
  // ─────────────────────────────────────────────────────────────────────────
  // `openshell sandbox exec` uses the gRPC exec endpoint, which is explicitly
  // NOT designed for interactive sessions (see `openshell sandbox exec --help`:
  // "For interactive shell sessions, use sandbox connect instead").  When
  // --tty is forced the gRPC server allocates a container PTY, but the gRPC
  // streaming layer does not forward ioctl/tcsetattr operations from inside the
  // container back to the wire protocol.  The PTY stays in ICANON+ECHO
  // (cooked mode) regardless of `stty -icanon -echo` or
  // `process.stdin.setRawMode(true)` calls inside the container — any key the
  // user presses is echoed back and line-buffered until Enter, so Claude Code's
  // TUI never receives individual keystrokes.
  //
  // WHY SSH fixes it
  // ─────────────────
  // `openshell sandbox connect` (and direct SSH via sandbox ssh-config) use a
  // real SSH PTY request.  SSH calls cfmakeraw on the local (WSL) PTY slave,
  // negotiates a container PTY via pty-request, and the Linux kernel's PTY line
  // discipline on both ends handles ECHO/ICANON correctly.
  // `process.stdin.setRawMode(true)` inside Claude Code then works end-to-end.
  //
  // STRATEGY
  // ─────────
  // 1. SSH-first: ask openshell for the sandbox SSH config, write it to a
  //    temp file, extract the Host alias, then exec ssh with `openeral` as
  //    the remote command.  The API key is already baked into the container at
  //    creation time (--auto-providers), so no extra env forwarding is needed
  //    for subsequent connections.
  //
  // 2. gRPC-exec fallback: if the gateway is offline, the sandbox isn't ready,
  //    or ssh-config is otherwise unavailable, fall through to the original
  //    `sandbox exec --tty -- bash -c 'stty ...; exec openeral'` path.  This
  //    preserves connectivity during gateway downtime even if the TUI won't be
  //    fully interactive.
  //
  // DIMENSIONS
  // ──────────
  // The outer `stty cols X rows Y` sets TIOCGWINSZ on the WSL PTY BEFORE ssh
  // starts.  ssh reads TIOCGWINSZ from its stdin (WSL PTY slave) when building
  // the pty-request, so the correct dimensions are sent to the container PTY.
  // ── Connect path: SSH-first with gRPC exec fallback ─────────────────────────
  // The sandbox is always provisioned before the PTY opens (createOpenEralSandbox
  // in openeral.mjs runs `create --no-tty -- /bin/true` + waitForSandboxReady).
  // We therefore always connect — never create — from the PTY layer.
  const shellCmd =
    // Set WSL PTY dimensions AND raw mode before SSH / gRPC exec starts.
    // -icanon -echo prevents the WSL bash layer from line-buffering or
    // echoing keystrokes (which caused stray `)` characters in the terminal).
    // SSH reads TIOCGWINSZ from the PTY slave for its pty-request, so the
    // correct cols/rows reach the container PTY automatically.
    `stty cols ${cols} rows ${rows} -icanon -echo min 1 time 0 2>/dev/null; ` +
    // ── SSH path ──────────────────────────────────────────────────────────
    // mktemp + ssh-config + awk extract the Host alias; command -v guards
    // against missing ssh binary.  exec ssh replaces the bash process so the
    // gRPC fallback below is never reached on success.
    //
    // NOTE: _cfg=$(mktemp) uses ; not && because variable assignments always
    // exit 0 in bash — even when mktemp fails.  Using && here would not guard
    // against mktemp failure; _cfg would be empty and > "$_cfg" would try to
    // redirect stdout to an empty filename, printing a bash error to the
    // terminal.  The explicit [ -n "$_cfg" ] guard below is the correct check.
    //
    // The trap removes the temp config file whether bash exits normally or is
    // killed (e.g. user closes the terminal tab). This prevents /tmp leaks
    // in the WSL distro on repeated session open/close cycles.
    //
    // awk 2>/dev/null: suppresses "cannot open" noise that some awk builds
    // print to stderr when the ssh-config file is empty or malformed (e.g.
    // when openshell returns an error line to stdout for a not-yet-ready
    // sandbox). The awk exit code is still captured via $() command
    // substitution — only the stderr error text is silenced.
    `_cfg=$(mktemp /tmp/ow-ssh-XXXXXX.conf 2>/dev/null); ` +
    `trap 'rm -f "$_cfg"' EXIT; ` +
    `[ -n "$_cfg" ] && ` +
    `openshell sandbox ssh-config ${quotedName} > "$_cfg" 2>/dev/null && ` +
    `_host=$(awk '/^Host /{print $2; exit}' "$_cfg" 2>/dev/null) && ` +
    `[ -n "$_host" ] && command -v ssh > /dev/null 2>&1 && ` +
    `exec ssh -t -F "$_cfg" -o StrictHostKeyChecking=no "$_host" openeral; ` +
    // ── gRPC exec fallback ────────────────────────────────────────────────
    // Used when SSH is not available.  Sets raw mode inside the container
    // bash before exec'ing openeral so the container PTY at least starts in
    // raw mode (may be reset by setup.sh before Claude Code runs).
    `exec openshell sandbox exec --name ${quotedName} --tty -- ` +
    `bash -c 'stty cols ${cols} rows ${rows} -icanon -echo min 1 time 0 2>/dev/null; exec openeral'`;
  return pty.spawn(
    "wsl.exe",
    ["-d", DISTRO_NAME, "--", "bash", "-c", shellCmd],
    {
      name: "xterm-256color",
      cols,
      rows,
      // Forward credentials via WSLENV for both paths. Create path needs
      // DATABASE_URL (written to temp file for --upload). Connect path needs
      // ANTHROPIC_API_KEY / STRINGCOST_API_KEY (SSH path bakes them in at
      // creation time; gRPC fallback needs them forwarded on first run).
      env: extraEnv ? buildWslEnv(extraEnv) : process.env,
      cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
    },
  );
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/**
 * Open a new PTY session against an existing OpenEral sandbox.
 *
 * @param {Object} opts
 * @param {string} opts.sandboxName
 * @param {number} [opts.cols]
 * @param {number} [opts.rows]
 * @param {Record<string, string>} [opts.extraEnv]  Extra env vars forwarded
 *   into WSL via WSLENV (e.g. ANTHROPIC_API_KEY, STRINGCOST_API_KEY). These
 *   are needed so Claude Code can auto-configure its provider on first run
 *   inside the sandbox without prompting the user interactively.
 * @param {DataHandler} [opts.onData]   Receives PTY stdout/stderr bytes
 * @param {ExitHandler} [opts.onExit]   Called when the wsl child exits
 * @returns {Promise<{ id: string, sandboxName: string }>}
 */
export async function openSession(opts) {
  if (!opts?.sandboxName) {
    throw new Error("openSession: sandboxName is required");
  }
  const cols = Number.isFinite(opts.cols) ? opts.cols : DEFAULT_COLS;
  const rows = Number.isFinite(opts.rows) ? opts.rows : DEFAULT_ROWS;
  const extraEnv = opts.extraEnv ?? null;

  const pty = await spawnImpl({ sandboxName: opts.sandboxName, cols, rows, extraEnv });
  const id = randomUUID();

  /** @type {Session} */
  const session = {
    id,
    sandboxName: opts.sandboxName,
    pty,
    onData: opts.onData ?? null,
    onExit: opts.onExit ?? null,
    size: { cols, rows },
    openedAt: Date.now(),
  };

  // Wire data → caller. node-pty's onData fires for both stdout and
  // stderr — there's no TTY-side distinction, which is exactly what
  // xterm.js expects.
  pty.onData((data) => {
    session.onData?.(data);
  });

  pty.onExit((event) => {
    sessions.delete(id);
    const code = typeof event?.exitCode === "number" ? event.exitCode : null;
    const signal =
      typeof event?.signal === "number" ? String(event.signal) : event?.signal ?? null;
    session.onExit?.(code, signal);
  });

  sessions.set(id, session);
  return { id, sandboxName: opts.sandboxName };
}

/**
 * Write bytes from the renderer's xterm to the PTY's stdin. Returns
 * `false` if the session is unknown (caller can decide whether to
 * surface that or swallow it — keystrokes after close are noise).
 */
export function writeSession(id, data) {
  const session = sessions.get(id);
  if (!session) return false;
  session.pty.write(typeof data === "string" ? data : String(data));
  return true;
}

/**
 * Forward an xterm.js resize. Returns `false` if the session is gone.
 * No-op (returns true) if the size hasn't changed — saves the SIGWINCH
 * cost on every renderer re-paint.
 */
export function resizeSession(id, cols, rows) {
  const session = sessions.get(id);
  if (!session) return false;
  const safeCols = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : session.size.cols;
  const safeRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : session.size.rows;
  if (safeCols === session.size.cols && safeRows === session.size.rows) {
    return true;
  }
  session.pty.resize(safeCols, safeRows);
  session.size = { cols: safeCols, rows: safeRows };
  return true;
}

/**
 * Kill the PTY's wsl child. The onExit handler fires synchronously and
 * removes the session from the map. The OpenEral sandbox itself
 * persists — that's the whole point of OpenEral's PostgreSQL-backed
 * /home/agent.
 */
export function closeSession(id, signal = "SIGTERM") {
  const session = sessions.get(id);
  if (!session) return false;
  try {
    session.pty.kill(signal);
  } catch {
    // Already exited; the onExit cleanup may not have run yet.
    sessions.delete(id);
  }
  return true;
}

/**
 * Renderer-safe view of every live session. Used by the workspace tab
 * UI to show "session active" badges and by the doctor to count open
 * sessions per sandbox.
 */
export function listSessions() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    sandboxName: s.sandboxName,
    cols: s.size.cols,
    rows: s.size.rows,
    openedAt: s.openedAt,
    pid: s.pty.pid ?? null,
  }));
}

/**
 * Replace data/exit handlers for a live session. Used when the renderer
 * remounts (e.g., user toggles between session tabs) so the new
 * component picks up the existing PTY without spawning a new one.
 *
 * @param {string} id
 * @param {{ onData?: DataHandler | null, onExit?: ExitHandler | null }} [handlers]
 */
export function attachHandlers(id, handlers = {}) {
  const { onData, onExit } = handlers;
  const session = sessions.get(id);
  if (!session) return false;
  if (onData !== undefined) session.onData = onData ?? null;
  if (onExit !== undefined) session.onExit = onExit ?? null;
  return true;
}

/** Tear down every session. Called on app quit / runtime shutdown. */
export function closeAllSessions() {
  for (const id of Array.from(sessions.keys())) {
    closeSession(id);
  }
}

export const __testing = {
  /**
   * Replace the node-pty spawn with a stub. The stub receives the same
   * options openSession would pass and must return an IPty-like object.
   * Use clearSpawnImpl() to restore the default.
   */
  installSpawnImpl(fn) {
    spawnImpl = fn;
  },
  clearSpawnImpl() {
    spawnImpl = async ({ sandboxName, cols, rows, extraEnv }) => {
      const pty = await import("node-pty");
      const quotedName = `'${sandboxName.replace(/'/g, "'\\''")}'`;
      const shellCmd =
        `stty cols ${cols} rows ${rows} -icanon -echo min 1 time 0 2>/dev/null; ` +
        `_cfg=$(mktemp /tmp/ow-ssh-XXXXXX.conf 2>/dev/null); ` +
        `trap 'rm -f "$_cfg"' EXIT; ` +
        `[ -n "$_cfg" ] && ` +
        `openshell sandbox ssh-config ${quotedName} > "$_cfg" 2>/dev/null && ` +
        `_host=$(awk '/^Host /{print $2; exit}' "$_cfg" 2>/dev/null) && ` +
        `[ -n "$_host" ] && command -v ssh > /dev/null 2>&1 && ` +
        `exec ssh -t -F "$_cfg" -o StrictHostKeyChecking=no "$_host" openeral; ` +
        `exec openshell sandbox exec --name ${quotedName} --tty -- ` +
        `bash -c 'stty cols ${cols} rows ${rows} -icanon -echo min 1 time 0 2>/dev/null; exec openeral'`;
      return pty.spawn(
        "wsl.exe",
        ["-d", DISTRO_NAME, "--", "bash", "-c", shellCmd],
        {
          name: "xterm-256color",
          cols,
          rows,
          env: extraEnv ? buildWslEnv(extraEnv) : process.env,
          cwd: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
        },
      );
    };
  },
  getSessionCount() {
    return sessions.size;
  },
  resetAll() {
    closeAllSessions();
    sessions.clear();
  },
};
