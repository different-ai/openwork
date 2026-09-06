import AppKit
import Foundation

setbuf(stdout, nil)
let command = CommandLine.arguments.dropFirst().first ?? "setup"

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
case "--list-apps":
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && AppIdentity.isAllowed($0) }
        .compactMap(\.localizedName).sorted()
    printJSON(["ok": true, "apps": apps])
case "mcp":
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
case "setup":
    NSApplication.shared.setActivationPolicy(.regular)
    let delegate = PermissionSetup()
    NSApplication.shared.delegate = delegate
    withExtendedLifetime(delegate) { NSApplication.shared.run() }
default:
    fputs("Usage: ComputerUse [mcp|--check|--list-apps|setup]\n", stderr)
    exit(1)
}
}
