import { execFile } from "@openwork/child-process";
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

/** No capture, transcript storage, speech service, or shell interpolation. */
export function createNativeDictation({ platform, menu, processId, systemRoot, execute = run }) {
  /** @type {{ id: string; sender: unknown; controller: AbortController } | null} */
  let pending = null;
  /** @returns {Promise<import("@openwork/types/desktop-ipc").DesktopCommandResult<"__startNativeDictation">>} */
  async function start(event, window, requestId) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame
      || !window.isFocused() || !event.sender.isFocused()) return { ok: false, reason: "not_focused" };
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
