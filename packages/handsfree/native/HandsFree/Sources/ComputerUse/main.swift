/// Computer Use: semantic AX and background-safe macOS computer use.
///
/// Four modes:
///   mcp          — run the MCP server over stdio
///   --check      — print permission status as JSON to stdout and exit
///   --list-apps  — print running regular apps as JSON to stdout and exit
///   (default)    — open the permission setup GUI

import AppKit
import Foundation

setbuf(stdout, nil)

let args = CommandLine.arguments
let subcommand = args.count >= 2 ? args[1] : ""

switch subcommand {
case "mcp":
    if ProcessInfo.processInfo.environment["OPENWORK_COMPUTER_USE_CURSOR_OVERLAY"] == "0" {
        let server = MCPServer()
        await server.run()
    } else {
        await runMCPServerWithOverlay()
    }
case "--check":
    // Fresh process → fresh TCC read → always accurate.
    let status = ComputerUsePermissions.status()
    let json = "{\"ok\":\(status.ok),\"accessibility\":\(status.accessibility),\"screenRecording\":\(status.screenRecording)}"
    print(json)
    exit(0)
case "--list-apps":
    // Running regular apps (Dock-visible). Needs no TCC permissions, so this
    // is safe to call from the composer at any time.
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap(\.localizedName)
        .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    let payload: [String: Any] = ["ok": true, "apps": apps]
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{\"ok\":false,\"apps\":[]}".utf8)
    print(String(decoding: data, as: UTF8.self))
    exit(0)
default:
    await runPermissionSetupApp()
}

@MainActor
func runMCPServerWithOverlay() async {
    NSApplication.shared.setActivationPolicy(.accessory)
    let server = MCPServer()
    Task.detached {
        await server.run()
        await MainActor.run {
            NSApplication.shared.terminate(nil)
        }
    }
    NSApplication.shared.run()
}

@MainActor
func runPermissionSetupApp() async {
    NSApplication.shared.setActivationPolicy(.regular)
    let appDelegate = PermissionSetupAppDelegate()
    NSApplication.shared.delegate = appDelegate
    NSApplication.shared.run()
}
