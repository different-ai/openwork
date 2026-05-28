/// Computer Use: semantic AX and background-safe macOS computer use.
///
/// Three modes:
///   mcp       — run the MCP server over stdio
///   --check   — print permission status as JSON to stdout and exit
///   (default) — open the permission setup GUI

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
