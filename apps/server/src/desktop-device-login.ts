import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const discoverySchema = z.object({ baseUrl: z.string().url(), token: z.string().min(1) });
const receiptSchema = z.object({ ok: z.boolean(), code: z.string().optional(), result: z.unknown().optional() });
const startedSchema = z.object({
  userCode: z.string().min(1), verificationUri: z.string().url(),
  verificationUriComplete: z.string().url().optional(), expiresAt: z.number().finite(),
});
const statusSchema = z.object({
  state: z.enum(["pending", "approved", "denied", "expired", "unsupported", "failed", "signed_in"]),
  email: z.string().optional(), org: z.object({ id: z.string(), name: z.string() }).optional(),
  runner: z.enum(["connected", "session_only", "not_connected", "unknown"]).optional(),
});

/** Only the existing local bridge credential crosses this boundary, never a Den credential. */
async function desktopBridge() {
  // POSIX custody can be verified without guessing inherited Windows ACLs.
  if (!process.getuid) throw new Error("Device sign-in requires a local desktop profile with verifiable owner-only permissions.");
  const uid = process.getuid();
  const appData = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const explicit = process.env.OPENWORK_UI_CONTROL_DISCOVERY?.trim();
  const candidates = explicit ? [explicit] : [join(appData, "com.differentai.openwork", "openwork-ui-control.json")];
  for (const candidate of candidates) {
    try {
      const file = resolve(candidate);
      let current = dirname(file);
      let privateAncestor = false;
      while (true) {
        const info = await lstat(current);
        if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0)
          || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) {
          throw new Error("Untrusted desktop profile");
        }
        if (info.uid === uid && (info.mode & 0o077) === 0) privateAncestor = true;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.uid !== uid || (info.mode & 0o022) !== 0
          || (!privateAncestor && (info.mode & 0o077) !== 0)) throw new Error("Untrusted desktop discovery");
        const bridge = discoverySchema.parse(JSON.parse(await handle.readFile("utf8")));
        const url = new URL(bridge.baseUrl);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
          || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
          throw new Error("Non-local desktop bridge");
        }
        return bridge;
      } finally { await handle.close(); }
    } catch {
      // Never fall through from an explicit profile to another desktop.
    }
  }
  throw new Error("OpenWork's local desktop bridge is unavailable or its profile permissions are unsafe. Open the app and use an owner-only profile.");
}

function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Shell adapter only: the running desktop owns start, polling, tokens and durable enrollment. */
export async function runDesktopDeviceLogin(argv: string[]): Promise<number> {
  const args: { baseUrl?: string; apiBaseUrl?: string; force?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log("openwork-server device-login [--base-url URL] [--api-base-url URL] [--force]");
      return 0;
    }
    if (arg === "--force") { args.force = true; continue; }
    if ((arg === "--base-url" || arg === "--api-base-url") && argv[i + 1]) {
      const value = argv[++i];
      if (arg === "--base-url") args.baseUrl = value;
      else args.apiBaseUrl = value;
      continue;
    }
    console.error("Unknown or missing device-login option. Use --help.");
    return 1;
  }
  if (process.platform === "win32") {
    console.error("The device sign-in command is not available on Windows. Use the sign-in link instead.");
    return 4;
  }
  let cancel: (() => Promise<unknown>) | undefined;
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const bridge = await desktopBridge();
    async function request(kind: "query" | "command", id: string, input: unknown = {}, cleanup = false) {
      if (!cleanup) stop.signal.throwIfAborted();
      const timeout = AbortSignal.timeout(15_000);
      const response = await fetch(new URL(`/${kind}`, bridge.baseUrl), {
        method: "POST", redirect: "error", signal: cleanup ? timeout : AbortSignal.any([stop.signal, timeout]),
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ id, args: input }),
      });
      if (!response.ok) throw new Error("Desktop control request failed");
      const receipt = receiptSchema.parse(await response.json());
      if (!cleanup) stop.signal.throwIfAborted();
      return receipt;
    }
    // Missing actions mean an older app. A historical unsupported result must
    // not prevent retrying after rollout or against an explicit new destination.
    const before = await request("query", "auth.device-login.status");
    if (!before.ok) {
      console.error("Device sign-in is not available on this server. Use the sign-in link instead.");
      return 4;
    }
    stop.signal.throwIfAborted();
    // Arm cleanup before dispatch: losing the receipt must not leave a live
    // authorization running. Only an explicit conflict is safe to retry.
    cancel = async () => {
      const deadline = Date.now() + 20_000;
      let receipt = await request("command", "auth.device-login.cancel", {}, true);
      while (!receipt.ok && receipt.code === "conflict" && Date.now() < deadline) {
        await delay(250);
        receipt = await request("command", "auth.device-login.cancel", {}, true);
      }
    };
    const start = await request("command", "auth.device-login.start", args);
    if (!start.ok) {
      cancel = undefined; // An explicit refusal did not start a new flow.
      if (start.code === "unsupported") {
        console.error("Device sign-in is not available on this server. Use the sign-in link instead.");
        return 4;
      }
      console.error("Device sign-in could not start. If already signed in, use --force to replace that sign-in.");
      return 1;
    }
    if (statusSchema.safeParse(start.result).data?.state === "unsupported") {
      console.error("Device sign-in is not available on this server. Use the sign-in link instead.");
      return 4;
    }
    const started = startedSchema.parse(start.result);
    console.log(`Open ${printable(started.verificationUriComplete ?? started.verificationUri)}`);
    console.log(`Code: ${printable(started.userCode)}`);
    const deadline = Math.min(started.expiresAt, Date.now() + 15 * 60_000);
    while (!stop.signal.aborted && Date.now() < deadline) {
      await delay(1_000, undefined, { signal: stop.signal });
      const receipt = await request("query", "auth.device-login.status");
      if (!receipt.ok) throw new Error("Desktop status unavailable");
      const status = statusSchema.parse(receipt.result);
      if (status.state === "pending" || status.state === "approved") continue;
      if (status.state === "signed_in" && status.email && status.org) {
        cancel = undefined;
        console.log(`Signed in as ${printable(status.email)} in ${printable(status.org.name)}. Runner: ${status.runner ?? "unknown"}`);
        return 0;
      }
      console.error(status.state === "unsupported"
        ? "Device sign-in is not available on this server. Use the sign-in link instead."
        : `Device sign-in ${status.state}.`);
      return status.state === "denied" ? 2 : status.state === "expired" ? 3 : status.state === "unsupported" ? 4 : 1;
    }
    console.error(stop.signal.aborted ? "Device sign-in cancelled." : "Device sign-in expired.");
    return stop.signal.aborted ? 130 : 3;
  } catch {
    // Never print raw control receipts, HTTP bodies or errors containing credentials.
    console.error(stop.signal.aborted ? "Device sign-in cancelled." : "Device sign-in failed. Check that the local OpenWork app is running with an owner-only profile; use the sign-in link if this server is unsupported.");
    return stop.signal.aborted ? 130 : 1;
  } finally {
    await cancel?.().catch(() => undefined);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
