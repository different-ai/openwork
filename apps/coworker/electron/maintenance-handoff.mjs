import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertResetConfirmation, createMaintenance, createMaintenanceAdmission, validateMaintenancePaths } from "./maintenance.mjs";

const PREPARE_TIMEOUT = 20_000;
const ARM_TIMEOUT = 180_000;
const EXIT_TIMEOUT = 30_000;
const ticketPattern = /^[a-f0-9]{64}$/;
const recoveryDirectory = (userData) => path.join(path.dirname(userData), `${path.basename(userData)}-recovery`);
const pendingFile = (directory) => path.join(directory, "pending-reset.json");
const resultFile = (directory) => path.join(directory, "reset-result.json");
const cancellationFile = (directory, ticket) => path.join(directory, `cancel-${ticket}.json`);
let bootIdentity;
const systemText = (file, args) => execFileSync(file, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const windowsMetadata = (script) => systemText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

function currentBootIdentity() {
  if (bootIdentity) return bootIdentity;
  if (process.platform === "darwin") bootIdentity = systemText("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
  else if (process.platform === "linux") bootIdentity = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  else if (process.platform === "win32") bootIdentity = windowsMetadata("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')");
  if (!bootIdentity) throw new Error("The operating system boot identity is unavailable.");
  return bootIdentity;
}

export function maintenanceProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid previous-process identity.");
  if (!alive(pid)) return null;
  const boot = currentBootIdentity();
  let started;
  try {
    if (process.platform === "darwin") {
      started = systemText("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
    } else if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } else if (process.platform === "win32") {
      // Fixed OS metadata queries, never renderer-provided commands or args.
      started = windowsMetadata(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CreationDate.ToUniversalTime().ToString('o')`);
    } else throw new Error("Process identity is unavailable on this platform.");
  } catch (error) { if (!alive(pid)) return null; throw error; }
  if (!started) throw new Error("Process identity could not be verified.");
  return { pid, boot, started };
}

export const captureMaintenanceProcesses = (pids) => [...new Set(pids)].map(maintenanceProcessIdentity).filter(Boolean);

function processMatches(identity) {
  if (!identity || typeof identity.boot !== "string" || typeof identity.started !== "string") return false;
  if (identity.boot !== currentBootIdentity()) return false;
  const current = maintenanceProcessIdentity(identity.pid);
  return current?.boot === identity.boot && current?.started === identity.started;
}

export function maintenanceLaunchArguments(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid native relaunch arguments.");
  return args.filter((arg) => !/^opencoworker:\/\//i.test(arg) && !/^--(?:coworker-maintenance|fresh-start)(?:[-=]|$)/.test(arg));
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid previous-process identity.");
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

export async function waitForMaintenanceExit(processes, timeoutMs = EXIT_TIMEOUT, assertAllowed = async () => {}) {
  if (!Array.isArray(processes) || processes.some((entry) => entry.pid === process.pid)) throw new Error("Invalid previous-process set.");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await assertAllowed();
    const remaining = processes.filter(processMatches);
    if (!remaining.length) return;
    if (Date.now() >= deadline) {
      const error = new Error("Previous application processes have not all exited.");
      error.processes = remaining.map(({ pid }) => {
        let state = "unknown";
        try {
          if (process.platform === "darwin") state = systemText("/bin/ps", ["-p", String(pid), "-o", "stat="]);
          else if (process.platform === "linux") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
          }
        } catch {}
        return { pid, state };
      });
      throw error;
    }
    await delay(50);
  }
}

function assertPrivate(stat, directory = false) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || (process.getuid && stat.uid !== process.getuid())
    || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("The maintenance receipt is not private owned storage.");
}

async function writeReceipt(file, value, exclusive = false) {
  const temporary = exclusive ? file : `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await rename(temporary, file);
  if (process.platform !== "win32") {
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function assertTicket(directory, ticket) {
  assertPrivate(await lstat(directory), true);
  const file = pendingFile(directory);
  assertPrivate(await lstat(file));
  const current = JSON.parse(await readFile(file, "utf8"));
  if (current.version !== 2 || current.ticket !== ticket || current.helper?.pid !== process.pid || !processMatches(current.helper)) throw new Error("The reset ticket changed.");
}

async function removeTicket(directory, ticket) {
  await assertTicket(directory, ticket);
  await unlink(pendingFile(directory));
  if (process.platform !== "win32") {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

function receive(channel, ticket, type, timeoutMs) {
  if (!channel.connected) return Promise.reject(new Error("The native maintenance channel is disconnected."));
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      channel.removeListener("message", message);
      channel.removeListener("error", failed);
      channel.removeListener("exit", failed);
      channel.removeListener("disconnect", failed);
      error ? reject(error) : resolve(value);
    };
    const failed = () => finish(new Error("The native maintenance helper disconnected before acknowledging the handoff."));
    const message = (value) => {
      if (!value || value.ticket !== ticket) return;
      if (value.type === "failed" || value.type === "cancel") return finish(new Error("Fresh start preparation was refused. Nothing was erased; quit and reopen before retrying."));
      if (value.type === type) finish(null, value);
    };
    const timer = setTimeout(() => finish(new Error("The native maintenance handoff timed out. Nothing was erased.")), timeoutMs);
    channel.on("message", message);
    channel.once("error", failed);
    channel.once("exit", failed);
    channel.once("disconnect", failed);
  });
}

function send(channel, value) {
  return new Promise((resolve, reject) => channel.send(value, (error) => error ? reject(error) : resolve()));
}

/** No CLI paths or environment tickets: the inherited private IPC channel is
 * the capability, and the nonce binds prepare/arm to this one native request. */
export async function prepareMaintenanceHandoff({ input, scope, helperPath, executable = process.execPath, args, cwd = process.cwd(), env = process.env, ackTimeoutMs = PREPARE_TIMEOUT }) {
  assertResetConfirmation(input);
  const plan = await validateMaintenancePaths(scope);
  const ticket = randomBytes(32).toString("hex");
  const launch = { executable, args: maintenanceLaunchArguments(args), cwd };
  const child = spawn(executable, [helperPath], { cwd: path.dirname(executable), env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, shell: false, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  // Always observe asynchronous spawn errors, including after a cancelled wait.
  child.on("error", () => {});
  let prepared = false;
  let state = "preparing";
  const cancel = async () => {
    state = "cancelled";
    // This durable veto precedes permission to quit, even when an IPC ack was
    // lost. The helper rechecks it after process exit and before mutation.
    if (prepared) {
      try { await writeReceipt(cancellationFile(plan.backupDirectory, ticket), { ticket }, true); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    if (child.connected) await send(child, { type: "cancel", ticket }).catch(() => {});
    if (child.connected) child.disconnect();
    child.unref();
  };
  try {
    const ready = receive(child, ticket, "ready", PREPARE_TIMEOUT);
    void ready.catch(() => {});
    await send(child, { type: "prepare", ticket, parentPid: process.pid, scope, launch });
    await ready;
    prepared = true;
    state = "prepared";
    return {
      ticket, pid: child.pid, backupDirectory: plan.backupDirectory,
      async arm(previousProcesses) {
        if (state !== "prepared") throw new Error("This reset handoff was already consumed or cancelled.");
        state = "arming";
        const ack = receive(child, ticket, "armed", ackTimeoutMs);
        void ack.catch(() => {});
        await send(child, { type: "arm", ticket, previousProcesses: [maintenanceProcessIdentity(process.pid), ...previousProcesses] });
        await ack;
        if (state === "cancelled") throw new Error("The reset handoff was cancelled.");
        state = "armed";
      },
      async commit() {
        if (state !== "armed") throw new Error("Fresh start requires an acknowledged armed handoff.");
        state = "committing";
        const ack = receive(child, ticket, "committed", ackTimeoutMs);
        void ack.catch(() => {});
        await send(child, { type: "commit", ticket });
        await ack;
        if (state === "cancelled") throw new Error("The reset handoff was cancelled.");
        state = "committed";
        child.disconnect();
        child.unref();
      },
      cancel,
    };
  } catch (error) { await cancel(); throw error; }
}

/** Invoked only by the separately bundled helper entry, never by the app CLI. */
export async function runMaintenanceHelper(channel = process, { exitTimeoutMs = EXIT_TIMEOUT } = {}) {
  if (!channel.connected || typeof channel.send !== "function") throw new Error("Maintenance requires a native parent IPC channel.");
  const request = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Missing native preparation request.")), PREPARE_TIMEOUT);
    channel.once("message", (value) => { clearTimeout(timer); resolve(value); });
  });
  if (request?.type !== "prepare" || !ticketPattern.test(request.ticket) || request.parentPid !== process.ppid || !alive(request.parentPid)) throw new Error("Invalid native maintenance parent.");
  const { ticket, scope, launch } = request;
  let directory;
  let ownsTicket = false;
  let committed = false;
  const helper = maintenanceProcessIdentity(process.pid);
  const parent = maintenanceProcessIdentity(request.parentPid);
  let previousProcesses = [parent];
  const cancellation = new AbortController();
  const cancel = (message) => {
    if (message?.ticket === ticket && message.type === "cancel") cancellation.abort(new Error("Fresh start was cancelled."));
  };
  const disconnected = () => { if (!committed) cancellation.abort(new Error("The reset was not committed by its parent.")); };
  channel.on("message", cancel);
  channel.on("disconnect", disconnected);
  const assertAllowed = async () => {
    cancellation.signal.throwIfAborted();
    if (directory) {
      try { await lstat(cancellationFile(directory, ticket)); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      cancellation.abort(new Error("Fresh start was cancelled."));
      cancellation.signal.throwIfAborted();
    }
  };
  let backupPath = null;
  let result;
  let stage = "preparing";
  const ticketState = (phase) => ({ version: 2, ticket, helper, previousProcesses, phase, backupPath });
  try {
    if (launch?.executable !== process.execPath || !path.isAbsolute(launch.cwd)
      || JSON.stringify(maintenanceLaunchArguments(launch.args)) !== JSON.stringify(launch.args)) throw new Error("Invalid native relaunch identity.");
    const plan = await validateMaintenancePaths(scope);
    directory = plan.backupDirectory;
    for (const entry of plan.entries) for (const file of [launch.executable, launch.cwd]) {
      if (file === entry.source || file.startsWith(`${entry.source}${path.sep}`)) throw new Error("The running application cannot be inside reset storage.");
    }
    // Verify the actual helper runtime, even when no history DB exists yet.
    const { DatabaseSync } = await import("node:sqlite");
    const probe = new DatabaseSync(":memory:"); probe.close();
    const admission = createMaintenanceAdmission();
    const core = createMaintenance({ admission, paths: () => validateMaintenancePaths(scope), coworkerCount: async () => 0,
      stop: async () => { await waitForMaintenanceExit(previousProcesses, exitTimeoutMs, assertAllowed); return true; },
      onBackup: async (location) => {
        stage = "copying";
        await assertTicket(directory, ticket);
        backupPath = location;
        await writeReceipt(pendingFile(directory), ticketState("copying"));
      },
      beforeMutation: async () => { stage = "resetting"; await assertAllowed(); await assertTicket(directory, ticket); await writeReceipt(pendingFile(directory), ticketState("resetting")); },
      relaunch: async () => {},
    });
    await core.preview();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    assertPrivate(await lstat(directory), true);
    await assertAllowed();
    await writeReceipt(pendingFile(directory), ticketState("prepared"), true);
    ownsTicket = true;
    const arm = receive(channel, ticket, "arm", ARM_TIMEOUT);
    void arm.catch(() => {});
    await send(channel, { type: "ready", ticket });
    const accepted = await arm;
    if (!Array.isArray(accepted.previousProcesses) || !accepted.previousProcesses.some((entry) => JSON.stringify(entry) === JSON.stringify(parent))
      || accepted.previousProcesses.some((entry) => !Number.isSafeInteger(entry?.pid) || entry.pid < 2 || entry.pid === process.pid || typeof entry.boot !== "string" || typeof entry.started !== "string")) throw new Error("Invalid captured application processes.");
    previousProcesses = accepted.previousProcesses;
    await assertTicket(directory, ticket);
    await assertAllowed();
    await writeReceipt(pendingFile(directory), ticketState("armed"));
    const commitment = receive(channel, ticket, "commit", ARM_TIMEOUT);
    void commitment.catch(() => {});
    await send(channel, { type: "armed", ticket });
    await commitment;
    await assertAllowed();
    await writeReceipt(pendingFile(directory), ticketState("waiting-for-exit"));
    committed = true;
    await send(channel, { type: "committed", ticket });
    // No file copy, move, or shared history write occurs while any captured
    // parent/Chromium process is alive. Boot/start identities exclude PID reuse.
    stage = "waiting-for-exit";
    await waitForMaintenanceExit(previousProcesses, exitTimeoutMs, assertAllowed);
    await assertAllowed();
    await assertTicket(directory, ticket);
    stage = "validating-reset";
    const completed = await core.factoryReset({ confirmation: "DELETE" });
    result = { version: 2, ticket, phase: "completed", backupPath: completed.backupPath, previousProcesses, recoveryRequired: false };
  } catch (error) {
    if (!committed || (cancellation.signal.aborted && !error.recovery?.recoveryRequired && !error.recovery?.committed)) {
      if (ownsTicket) await removeTicket(directory, ticket);
      if (channel.connected) await send(channel, { type: "failed", ticket }).catch(() => {});
      return;
    }
    result = { version: 2, ticket, phase: error.recovery?.committed ? "completed" : "failed", backupPath: error.recovery?.backupPath ?? backupPath,
      previousProcesses, recoveryRequired: error.recovery?.recoveryRequired === true,
      diagnostics: { stage,
        ...(["ENOSPC", "EACCES", "EPERM", "ENOENT", "EIO"].includes(error.cause?.code ?? error.code) ? { code: error.cause?.code ?? error.code } : {}),
        ...(error.processes ? { processes: error.processes } : {}) } };
  } finally {
    channel.removeListener("message", cancel);
    channel.removeListener("disconnect", disconnected);
    if (directory && cancellation.signal.aborted) await unlink(cancellationFile(directory, ticket)).catch(() => {});
  }
  // The receipt contains no raw error, launch arguments, or inherited secrets.
  // It precedes relaunch, so the next app reports failure even after rollback.
  let receiptFailed = false;
  try {
    await writeReceipt(resultFile(directory), result);
    await removeTicket(directory, ticket);
  } catch { receiptFailed = true; }
  if (channel.connected) channel.disconnect();
  // A failed acknowledgement must not open a second app over a parent that
  // correctly stayed open. The durable failure is read on its next launch.
  if (processMatches(parent)) return;
  const env = { ...process.env };
  for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "NODE_UNIQUE_ID"]) delete env[name];
  for (const name of Object.keys(env)) if (name.startsWith("COWORKER_MAINTENANCE_")) delete env[name];
  // If even the durable receipt cannot be written, still relaunch into an
  // explicit native recovery error, never normal startup over uncertain state.
  if (receiptFailed) env.COWORKER_MAINTENANCE_RECOVERY_ERROR = "1";
  const next = spawn(launch.executable, launch.args, { cwd: launch.cwd, env, shell: false, detached: true, stdio: "ignore" });
  try { await new Promise((resolve, reject) => { next.once("spawn", resolve); next.once("error", reject); }); }
  catch (error) {
    await writeReceipt(resultFile(directory), { ...result, relaunchFailed: true });
    throw error;
  }
  next.unref();
}

/** Run synchronously before selecting/opening the original Electron profile.
 * A competing launch never opens half-moved state or races an active helper. */
export function readMaintenanceStartup(userData, { consume = true } = {}) {
  const directory = recoveryDirectory(userData);
  if (process.env.COWORKER_MAINTENANCE_RECOVERY_ERROR === "1") {
    delete process.env.COWORKER_MAINTENANCE_RECOVERY_ERROR;
    return { blocked: true, message: `Fresh start could not record its recovery status. The profile was not opened. Recovery needs attention in ${directory}.` };
  }
  try {
    for (let current = directory; ; current = path.dirname(current)) {
      try { if (lstatSync(current).isSymbolicLink()) throw new Error("Symlinked maintenance storage."); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (current === path.dirname(current)) break;
    }
    let pending;
    try { assertPrivate(lstatSync(directory), true); assertPrivate(lstatSync(pendingFile(directory))); pending = JSON.parse(readFileSync(pendingFile(directory), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (pending) {
      if (![1, 2].includes(pending.version) || !ticketPattern.test(pending.ticket)) throw new Error("Invalid maintenance ticket.");
      if (pending.version === 2 && !["prepared", "armed", "waiting-for-exit", "copying", "resetting"].includes(pending.phase)) throw new Error("Unknown maintenance phase.");
      if (pending.version === 2 && processMatches(pending.helper)) return { blocked: true, message: "Fresh start is still running. Open Coworker will reopen when it finishes." };
      if (pending.phase === "resetting" || pending.version === 1) return { blocked: true, message: `Fresh start was interrupted. Do not start new work over the recovery data. Recovery needs attention in ${directory}.` };
      if (consume) unlinkSync(pendingFile(directory));
      return { blocked: false, phase: "failed", backupPath: null };
    }
    let result;
    try { assertPrivate(lstatSync(resultFile(directory))); result = JSON.parse(readFileSync(resultFile(directory), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (![1, 2].includes(result.version) || !ticketPattern.test(result.ticket) || !["completed", "failed"].includes(result.phase)
      || (result.version === 2 && !Array.isArray(result.previousProcesses)) || (result.backupPath !== null && (path.dirname(result.backupPath) !== directory || !path.basename(result.backupPath).startsWith("fresh-start-")))) throw new Error("Invalid maintenance result.");
    if (result.recoveryRequired || (result.phase === "failed" && result.version === 2 && result.previousProcesses.some(processMatches))) return { blocked: true, message: `Fresh start stopped without confirmed cleanup. Your recovery data was kept in ${directory}. Close the previous app processes before reopening; recovery may need attention.` };
    if (consume) renameSync(resultFile(directory), path.join(directory, "reset-result-acknowledged.json"));
    return { blocked: false, phase: result.phase, backupPath: result.backupPath, ...(result.relaunchFailed ? { relaunchFailed: true } : {}) };
  } catch {
    return { blocked: true, message: "Open Coworker could not verify its Fresh start recovery receipt. The existing profile was not opened. Check the recovery directory before continuing." };
  }
}
