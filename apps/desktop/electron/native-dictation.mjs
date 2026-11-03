import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

/** Only the OS's fixed voice-typing chord is injected, never caller-supplied input.
 * Check foreground ownership inside the helper, immediately before SendInput:
 * focus can move while PowerShell starts. Do not release a person's held keys. */
export function windowsDictationScript(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error("Invalid process id");
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenWorkVoiceTyping {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT keyboard;
    [FieldOffset(0)] public MOUSEINPUT mouse;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int x; public int y; public uint data; public uint flags; public uint time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  static INPUT Key(ushort vk, uint flags) {
    return new INPUT { type = 1, data = new INPUTUNION { keyboard = new KEYBDINPUT { vk = vk, flags = flags } } };
  }
  public static bool Start() {
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    if (pid != ${processId}) return false;
    foreach (int key in new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
      if ((GetAsyncKeyState(key) & 0x8000) != 0) return false;
    INPUT[] keys = { Key(0x5B, 0), Key(0x48, 0), Key(0x48, 2), Key(0x5B, 2) };
    return SendInput(4, keys, Marshal.SizeOf(typeof(INPUT))) == 4;
  }
}
'@
if (-not [OpenWorkVoiceTyping]::Start()) { exit 2 }
`;
}

export const SPEECH_DICTATION_EVENT = "openwork:dictation:event";
const helperEvents = new Set(["ready", "result", "error", "end"]);
const speechErrors = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "network"]);

function trustedSender(event, window) {
  return Boolean(window && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame
    && window.isFocused() && event.sender.isFocused());
}

/** Forwards only the helper's known event shapes; transcript text stays in memory. */
export function helperEvent(line) {
  let value;
  try { value = JSON.parse(line) } catch { return null }
  if (!value || !helperEvents.has(value.type)) return null;
  if (value.type === "result") {
    if (!Array.isArray(value.segments) || value.segments.length > 500 || !value.segments.every(part => typeof part === "string")) return null;
    return { type: "result", segments: value.segments };
  }
  if (value.type === "error") return { type: "error", code: speechErrors.has(value.code) ? value.code : "network" };
  return { type: value.type };
}

/** Process environment the helper needs: Windows' speech stack and .NET look
 * up system folders; nothing carries provider credentials or loader overrides. */
function helperEnvironment(platform, env) {
  const keys = platform === "win32"
    ? ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData"]
    : ["HOME", "TMPDIR"];
  return Object.fromEntries(keys.filter(key => typeof env[key] === "string").map(key => [key, env[key]]));
}

/** Speech recognition through the bundled helper: Apple's on-device recognizer
 * on macOS ("local"), Windows' online speech recognition on Windows ("online").
 * One session at a time, owned by the main frame that started it. */
export function createSpeechDictation({ platform, helperPath, infoPlist, exists, readText, env = process.env, spawnHelper = spawn }) {
  /** @type {{ id: string; sender: any; child: import("node:child_process").ChildProcess; ended: boolean } | null} */
  let active = null;
  /** @type {"local" | "online" | null | undefined} */
  let resolved;
  /** @returns {"local" | "online" | null} */
  function mode() {
    if (resolved !== undefined) return resolved;
    try {
      if (platform === "win32") resolved = exists(helperPath) ? "online" : null;
      // Without this usage string macOS terminates the helper on the permission request.
      else if (platform === "darwin") resolved = exists(helperPath) && readText(infoPlist).includes("NSSpeechRecognitionUsageDescription") ? "local" : null;
      else resolved = null;
    } catch { resolved = null }
    return resolved;
  }
  function owns(event, requestId) {
    return Boolean(active && active.id === requestId && active.sender === event.sender && event.senderFrame === event.sender.mainFrame);
  }
  function send(session, payload) {
    if (payload.type === "end") session.ended = true;
    if (!session.sender.isDestroyed?.()) session.sender.send(SPEECH_DICTATION_EVENT, { id: session.id, ...payload });
  }
  return {
    mode,
    /** @returns {import("@openwork/types/desktop-ipc").DesktopCommandResult<"__startSpeechDictation">} */
    start(event, window, requestId, language) {
      if (!mode()) return { ok: false, reason: "unavailable" };
      if (!trustedSender(event, window)) return { ok: false, reason: "not_focused" };
      if (active || typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(requestId)) return { ok: false, reason: "failed" };
      const locale = typeof language === "string" && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,3}$/.test(language) ? language : "en-US";
      const child = spawnHelper(helperPath, ["--locale", locale], { stdio: ["pipe", "pipe", "ignore"], env: helperEnvironment(platform, env), windowsHide: true });
      const session = { id: requestId, sender: event.sender, child, ended: false };
      active = session;
      createInterface({ input: child.stdout }).on("line", line => {
        const payload = helperEvent(line);
        if (payload && !session.ended) send(session, payload);
      });
      const kill = () => child.kill();
      const close = () => {
        event.sender.removeListener?.("destroyed", kill);
        if (!session.ended) { send(session, { type: "error", code: "network" }); send(session, { type: "end" }) }
        if (active === session) active = null;
      };
      child.once("error", close);
      child.once("exit", close);
      child.stdin.on("error", () => {});
      event.sender.once?.("destroyed", kill);
      return { ok: true };
    },
    stop(event, requestId) {
      if (!owns(event, requestId)) return false;
      active.child.stdin.write("stop\n");
      return true;
    },
    abort(event, requestId) {
      if (!owns(event, requestId)) return false;
      const { child } = active;
      child.stdin.end();
      setTimeout(() => child.kill(), 2000).unref?.();
      return true;
    },
  };
}

/** No capture, transcript storage, speech service, or shell interpolation. */
export function createNativeDictation({ platform, menu, processId, systemRoot, execute = run }) {
  /** @type {{ id: string; sender: unknown; controller: AbortController } | null} */
  let pending = null;
  /** @returns {Promise<import("@openwork/types/desktop-ipc").DesktopCommandResult<"__startNativeDictation">>} */
  async function start(event, window, requestId) {
    if (!trustedSender(event, window)) return { ok: false, reason: "not_focused" };
    if (pending) return { ok: false, reason: "failed" };
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(requestId)) return { ok: false, reason: "failed" };
    if (platform === "darwin") {
      // Electron forwards this standard AppKit action to the focused editor.
      menu.sendActionToFirstResponder("startDictation:");
      return { ok: true };
    }
    if (platform !== "win32" || !systemRoot) return { ok: false, reason: "unavailable" };
    const request = { id: requestId, sender: event.sender, controller: new AbortController() };
    pending = request;
    try {
      const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      await execute(executable, ["-NoProfile", "-NonInteractive", "-Command", windowsDictationScript(processId)], {
        windowsHide: true, timeout: 8000, maxBuffer: 16_384,
        signal: request.controller.signal,
      });
      return { ok: true };
    } catch { return { ok: false, reason: "failed" } }
    finally { if (pending === request) pending = null }
  };
  return {
    start,
    cancel(event, requestId) {
      if (!pending || pending.id !== requestId || pending.sender !== event.sender || event.senderFrame !== event.sender.mainFrame) return false;
      pending.controller.abort();
      return true;
    },
  };
}
