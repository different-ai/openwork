import AppKit
import ApplicationServices
import Foundation

setbuf(stdout, nil)
let command = CommandLine.arguments.dropFirst().first ?? ""

@MainActor
func printJSON(_ payload: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

MainActor.assumeIsolated {
switch command {
case "--check":
    printJSON(SessionRuntime.permissions())
case "permissions":
    guard CommandLine.arguments.count == 3,
          ["accessibility", "screenRecording"].contains(CommandLine.arguments[2]) else { exit(1) }
    // Host apps own the explainer; only the signed helper requests its OS access.
    NSApplication.shared.setActivationPolicy(.accessory)
    let accessibility = CommandLine.arguments[2] == "accessibility"
    if accessibility {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    } else {
        CGRequestScreenCaptureAccess()
    }
    let pane = accessibility ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
    let opened = NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
    // Opening settings is not evidence that the person granted permission.
    printJSON(["opened": opened])
    if !opened { exit(1) }
case "permissions-guide":
    guard CommandLine.arguments.count == 3,
          let permission = GuidePermission(rawValue: CommandLine.arguments[2]) else { exit(1) }
    NSApplication.shared.setActivationPolicy(.accessory)
    let coach = PermissionCoach(permission: permission)
    NSApplication.shared.delegate = coach
    withExtendedLifetime(coach) { NSApplication.shared.run() }
case "mcp", "mcp-embedded":
    // mcp-embedded: the OpenWork desktop owns approval and Continue over the
    // private openwork/ui channel. mcp: standalone, with native consent and controls.
    SessionControls.embedded = command == "mcp-embedded"
    if SessionControls.embedded { MCPOutput.shared.enableNonblocking() }
    NSApplication.shared.setActivationPolicy(.accessory)
    let server = MCPServer()
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    for source in [termination, interruption] {
        source.setEventHandler { MainActor.assumeIsolated { server.shutdown(); NSApp.terminate(nil) } }
        source.resume()
    }
    // stdin is not the AppKit thread: Stop, expiry and cancellation remain live
    // while the client is idle. Reject oversized lines without parsing them.
    Task.detached {
        var pending = Data()
        var oversized = false
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { break }
            for byte in chunk {
                if byte == 10 {
                    if !oversized && !pending.isEmpty {
                        let message = pending
                        await server.receive(message)
                    }
                    pending.removeAll(keepingCapacity: true); oversized = false
                } else if !oversized {
                    if pending.count >= 1_048_576 { oversized = true; pending.removeAll(keepingCapacity: true) }
                    else { pending.append(byte) }
                }
            }
        }
        await MainActor.run { server.shutdown(); NSApp.terminate(nil) }
    }
    withExtendedLifetime([termination, interruption]) { NSApplication.shared.run() }
default:
    fputs("Usage: ComputerUse [mcp-embedded|mcp|--check|permissions accessibility|permissions screenRecording|permissions-guide accessibility|permissions-guide screenRecording]\n", stderr)
    exit(1)
}
}
