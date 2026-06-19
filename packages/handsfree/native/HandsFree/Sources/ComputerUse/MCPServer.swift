import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

actor MCPServer {
    private let runtime = ComputerUseRuntime()
    private let input = InputService()
    private var cuaSnapshotFrontmostPID: pid_t?

    func run() async {
        log("Computer Use server starting")
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                log("Invalid JSON-RPC line")
                continue
            }

            let id = json["id"]
            let method = json["method"] as? String ?? ""
            let params = json["params"] as? [String: Any] ?? [:]

            switch method {
            case "initialize":
                respond(id: id, result: [
                    "protocolVersion": "2025-03-26",
                    "capabilities": ["tools": [:]],
                    "serverInfo": ["name": "openwork-computer-use", "version": "0.1.0"],
                ])
            case "notifications/initialized":
                break
            case "tools/list":
                respond(id: id, result: ["tools": toolSchemas()])
            case "tools/call":
                let name = params["name"] as? String ?? ""
                let args = params["arguments"] as? [String: Any] ?? [:]
                let content = await executeTool(name: name, args: args)
                respond(id: id, result: ["content": content])
            default:
                if id != nil {
                    respondError(id: id, code: -32601, message: "Method not found: \(method)")
                }
            }
        }
    }

    private func toolSchemas() -> [[String: Any]] {
        [
            toolSchema(
                name: "snapshot",
                description: "Return target-window screenshot plus compact semantic AX state. Uses strict background activation by default.",
                properties: [
                    "app": ["type": "string", "description": "Optional running app name. Omit for frontmost app."],
                    "pid": ["type": "number", "description": "Optional process id. Disambiguates multiple instances of the same app."],
                    "window_title": ["type": "string", "description": "Optional window title to target a specific window."],
                    "strict": ["type": "boolean", "description": "Keep actions on background-safe AX/postToPid paths. Default true."],
                ]
            ),
            toolSchema(
                name: "click",
                description: "Click a semantic ref like {e1}, an index, or screenshot x/y. AX is tried first; strict mode only falls back to background postToPid.",
                properties: [
                    "ref": ["type": "string", "description": "Semantic ref from snapshot, e.g. {e1}."],
                    "snapshot_id": ["type": "string", "description": "Optional snapshot id from the latest snapshot response."],
                    "index": ["type": "number", "description": "Element id or zero-based compatibility index."],
                    "x": ["type": "number", "description": "Screenshot-image x coordinate (pixels in the snapshot image, e.g. element center.imageX). Not screen pixels."],
                    "y": ["type": "number", "description": "Screenshot-image y coordinate (pixels in the snapshot image, e.g. element center.imageY). Not screen pixels."],
                    "screen_x": ["type": "number", "description": "Absolute screen x coordinate (e.g. element center.screenX). Takes precedence over x/y."],
                    "screen_y": ["type": "number", "description": "Absolute screen y coordinate (e.g. element center.screenY). Takes precedence over x/y."],
                    "click_count": ["type": "number", "description": "1 or 2. Default 1."],
                    "strict": ["type": "boolean", "description": "Override strict mode for this action."],
                ]
            ),
            toolSchema(
                name: "type_text",
                description: "Type text into the target process. In strict mode this uses CGEvent.postToPid and does not move the real cursor.",
                properties: [
                    "text": ["type": "string", "description": "Text to type."],
                    "snapshot_id": ["type": "string", "description": "Optional snapshot id from the latest snapshot response."],
                    "strict": ["type": "boolean", "description": "Override strict mode for this action."],
                ]
            ),
            toolSchema(
                name: "press_key",
                description: "Press a key combo such as command+k, return, tab, or escape.",
                properties: [
                    "combo": ["type": "string", "description": "Key combo."],
                    "snapshot_id": ["type": "string", "description": "Optional snapshot id from the latest snapshot response."],
                    "strict": ["type": "boolean", "description": "Override strict mode for this action."],
                ]
            ),
            toolSchema(
                name: "scroll",
                description: "Scroll the target window without foregrounding it in strict mode.",
                properties: [
                    "direction": ["type": "string", "description": "up, down, left, or right."],
                    "snapshot_id": ["type": "string", "description": "Optional snapshot id from the latest snapshot response."],
                    "pages": ["type": "number", "description": "Approximate page count. Default 1."],
                    "x": ["type": "number", "description": "Optional screenshot x coordinate."],
                    "y": ["type": "number", "description": "Optional screenshot y coordinate."],
                    "strict": ["type": "boolean", "description": "Override strict mode for this action."],
                ]
            ),
            toolSchema(
                name: "set_value",
                description: "Set a semantic AX element value directly. This stays background-safe.",
                properties: [
                    "ref": ["type": "string", "description": "Semantic ref from snapshot."],
                    "snapshot_id": ["type": "string", "description": "Optional snapshot id from the latest snapshot response."],
                    "index": ["type": "number", "description": "Element id or zero-based compatibility index."],
                    "value": ["type": "string", "description": "Value to set."],
                ]
            ),
            toolSchema(
                name: "perform_action",
                description: "Perform a named AX action such as AXPress, AXShowMenu, AXIncrement, or AXDecrement.",
                properties: [
                    "ref": ["type": "string", "description": "Semantic ref from snapshot."],
                    "snapshot_id": ["type": "string", "description": "Optional snapshot id from the latest snapshot response."],
                    "index": ["type": "number", "description": "Element id or zero-based compatibility index."],
                    "action": ["type": "string", "description": "AX action name. Default AXPress."],
                ]
            ),
            toolSchema(
                name: "wait",
                description: "Wait for UI to settle.",
                properties: ["milliseconds": ["type": "number", "description": "Wait time. Default 1000."]]
            ),
            toolSchema(
                name: "set_strict_mode",
                description: "Enable or disable strict background mode. Strict mode rejects foreground fallbacks.",
                properties: ["enabled": ["type": "boolean", "description": "Whether strict background mode is enabled."]]
            ),
            toolSchema(name: "check_permissions", description: "Check Accessibility and Screen Recording permission status.", properties: [:]),
            toolSchema(name: "get_app_state", description: "Compatibility alias for snapshot.", properties: ["app": ["type": "string"], "strict": ["type": "boolean"]]),
            toolSchema(name: "launch_app", description: "Launch a macOS app by name.", properties: ["name": ["type": "string"]]),
            toolSchema(name: "activate_app", description: "Bring a running macOS app to the foreground.", properties: ["name": ["type": "string"]]),
            toolSchema(name: "list_apps", description: "List running regular macOS apps.", properties: [:]),
            toolSchema(name: "open_url", description: "Open a URL in the default browser or a specific browser app.", properties: ["url": ["type": "string"], "app": ["type": "string"]]),
            toolSchema(name: "clipboard_read", description: "Read text from the macOS clipboard.", properties: [:]),
            toolSchema(name: "clipboard_write", description: "Write text to the macOS clipboard.", properties: ["text": ["type": "string"]]),
            toolSchema(name: "display_info", description: "Return main display logical dimensions and scale factor.", properties: [:]),
            toolSchema(name: "cua_screenshot", description: "Compatibility full-screen screenshot for CUA loops. Returns logical-size PNG.", properties: [:]),
            toolSchema(name: "cua_click", description: "Compatibility click at absolute screen coordinates.", properties: ["x": ["type": "number"], "y": ["type": "number"]]),
            toolSchema(name: "cua_double_click", description: "Compatibility double-click at absolute screen coordinates.", properties: ["x": ["type": "number"], "y": ["type": "number"]]),
            toolSchema(name: "cua_move", description: "Compatibility mouse move to absolute screen coordinates.", properties: ["x": ["type": "number"], "y": ["type": "number"]]),
            toolSchema(name: "cua_type", description: "Compatibility text typing into focused input.", properties: ["text": ["type": "string"]]),
            toolSchema(name: "cua_keypress", description: "Compatibility keypress using CUA key names.", properties: ["keys": ["type": "array", "items": ["type": "string"]]]),
            toolSchema(name: "cua_scroll", description: "Compatibility scroll at absolute screen coordinates.", properties: ["x": ["type": "number"], "y": ["type": "number"], "scroll_x": ["type": "number"], "scroll_y": ["type": "number"]]),
            toolSchema(name: "cua_drag", description: "Compatibility drag over an array of [x,y] points.", properties: ["path": ["type": "array"]]),
            toolSchema(name: "cua_wait", description: "Compatibility wait for UI to settle.", properties: [:]),
        ]
    }

    private func toolSchema(name: String, description: String, properties: [String: Any]) -> [String: Any] {
        ["name": name, "description": description, "inputSchema": ["type": "object", "properties": properties]]
    }

    private func executeTool(name: String, args: [String: Any]) async -> [[String: Any]] {
        do {
            switch name {
            case "snapshot", "get_app_state":
                return try await snapshotResult(args: args)
            case "click":
                let metadata = try await runtime.click(
                    snapshotID: snapshotIDArg(args),
                    ref: args["ref"] as? String,
                    index: intArg(args, "index"),
                    imageX: doubleArg(args, "x"),
                    imageY: doubleArg(args, "y"),
                    screenX: doubleArg(args, "screen_x"),
                    screenY: doubleArg(args, "screen_y"),
                    clickCount: intArg(args, "click_count") ?? 1,
                    strict: boolArg(args, "strict")
                )
                return jsonResult(metadata.dictionary)
            case "type_text":
                let metadata = try await runtime.typeText(snapshotID: snapshotIDArg(args), text: args["text"] as? String ?? "", strict: boolArg(args, "strict"))
                return jsonResult(metadata.dictionary)
            case "press_key":
                let metadata = try await runtime.pressKey(snapshotID: snapshotIDArg(args), combo: args["combo"] as? String ?? "", strict: boolArg(args, "strict"))
                return jsonResult(metadata.dictionary)
            case "scroll":
                let metadata = try await runtime.scroll(
                    snapshotID: snapshotIDArg(args),
                    direction: args["direction"] as? String,
                    pages: doubleArg(args, "pages") ?? 1,
                    imageX: doubleArg(args, "x"),
                    imageY: doubleArg(args, "y"),
                    strict: boolArg(args, "strict")
                )
                return jsonResult(metadata.dictionary)
            case "set_value":
                let metadata = try await runtime.setValue(snapshotID: snapshotIDArg(args), ref: args["ref"] as? String, index: intArg(args, "index"), value: args["value"] as? String ?? "")
                return jsonResult(metadata.dictionary)
            case "perform_action":
                let metadata = try await runtime.performAction(snapshotID: snapshotIDArg(args), ref: args["ref"] as? String, index: intArg(args, "index"), action: args["action"] as? String ?? kAXPressAction)
                return jsonResult(metadata.dictionary)
            case "wait":
                let metadata = await runtime.wait(milliseconds: intArg(args, "milliseconds") ?? 1000)
                return jsonResult(metadata.dictionary)
            case "set_strict_mode":
                let metadata = await runtime.setStrictMode(boolArg(args, "enabled") ?? true)
                return jsonResult(metadata.dictionary)
            case "check_permissions":
                return jsonResult(checkPermissions())
            case "launch_app":
                return try await jsonResult(handleLaunchApp(args: args))
            case "activate_app":
                return jsonResult(handleActivateApp(args: args))
            case "list_apps":
                let details = runningApps()
                    .compactMap { app -> [String: Any]? in
                        guard let name = app.localizedName else { return nil }
                        return ["name": name, "pid": Int(app.processIdentifier)]
                    }
                return jsonResult([
                    "ok": true,
                    "apps": runningApps().compactMap(\.localizedName).sorted(),
                    "appDetails": details,
                ])
            case "open_url":
                return try await jsonResult(handleOpenURL(args: args))
            case "clipboard_read":
                return jsonResult(["ok": true, "text": NSPasteboard.general.string(forType: .string) ?? ""])
            case "clipboard_write":
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(args["text"] as? String ?? "", forType: .string)
                return jsonResult(["ok": true])
            case "display_info":
                return jsonResult(displayInfo())
            case "cua_screenshot":
                return try await cuaScreenshotResult()
            case "cua_click":
                try validateCuaSnapshotFresh()
                AgentCursorOverlay.shared.show(at: CGPoint(x: intArg(args, "x") ?? 0, y: intArg(args, "y") ?? 0))
                try await input.click(point: CGPoint(x: intArg(args, "x") ?? 0, y: intArg(args, "y") ?? 0))
                return jsonResult(["ok": true])
            case "cua_double_click":
                try validateCuaSnapshotFresh()
                AgentCursorOverlay.shared.show(at: CGPoint(x: intArg(args, "x") ?? 0, y: intArg(args, "y") ?? 0))
                try await input.click(point: CGPoint(x: intArg(args, "x") ?? 0, y: intArg(args, "y") ?? 0), doubleClick: true)
                return jsonResult(["ok": true])
            case "cua_move":
                try validateCuaSnapshotFresh()
                AgentCursorOverlay.shared.show(at: CGPoint(x: intArg(args, "x") ?? 0, y: intArg(args, "y") ?? 0))
                try input.moveMouse(point: CGPoint(x: intArg(args, "x") ?? 0, y: intArg(args, "y") ?? 0))
                return jsonResult(["ok": true])
            case "cua_type":
                try validateCuaSnapshotFresh()
                try input.typeText(args["text"] as? String ?? "")
                return jsonResult(["ok": true])
            case "cua_keypress":
                try validateCuaSnapshotFresh()
                try input.pressKey(cuaKeysToCombo(args["keys"] as? [String] ?? []))
                return jsonResult(["ok": true])
            case "cua_scroll":
                try validateCuaSnapshotFresh()
                AgentCursorOverlay.shared.show(at: CGPoint(x: intArg(args, "x") ?? 0, y: intArg(args, "y") ?? 0))
                try input.scroll(
                    point: CGPoint(x: intArg(args, "x") ?? 0, y: intArg(args, "y") ?? 0),
                    deltaX: Int32(intArg(args, "scroll_x") ?? 0),
                    deltaY: Int32(-(intArg(args, "scroll_y") ?? 0))
                )
                return jsonResult(["ok": true])
            case "cua_drag":
                try validateCuaSnapshotFresh()
                let path = parsePointPath(args["path"])
                if let first = path.first {
                    AgentCursorOverlay.shared.show(at: first)
                }
                try await input.drag(path: path)
                return jsonResult(["ok": true])
            case "cua_wait":
                try await Task.sleep(nanoseconds: 1_000_000_000)
                return jsonResult(["ok": true])
            default:
                return jsonResult(["ok": false, "error": "Unknown tool: \(name)"])
            }
        } catch {
            return jsonResult(errorPayload(error))
        }
    }

    private func snapshotResult(args: [String: Any]) async throws -> [[String: Any]] {
        let snapshot = try await runtime.snapshot(
            appName: args["app"] as? String,
            pid: intArg(args, "pid"),
            windowTitle: args["window_title"] as? String,
            strict: boolArg(args, "strict")
        )
        let payload = snapshotPayload(snapshot)
        guard let text = jsonString(payload) else {
            return textResult("Failed to serialize semantic AX snapshot.")
        }
        return [
            ["type": "image", "data": snapshot.screenshotData.base64EncodedString(), "mimeType": snapshot.screenshotMimeType],
            ["type": "text", "text": text],
        ]
    }

    private func snapshotPayload(_ snapshot: AppSnapshot) -> [String: Any] {
        let elements = snapshot.elements.map { element -> [String: Any] in
            var dict = element.dictionary
            let imagePoint = snapshot.screenshotMeta.toImage(point: element.frame.center)
            dict["center"] = [
                "screenX": Int(element.frame.center.x),
                "screenY": Int(element.frame.center.y),
                "imageX": Int(imagePoint.x),
                "imageY": Int(imagePoint.y),
            ]
            return dict
        }

        var result: [String: Any] = [
            "ok": true,
            "semanticAXVersion": 1,
            "snapshotId": snapshot.id,
            "snapshot_id": snapshot.id,
            "observation": snapshot.observation,
            "app": snapshot.appName,
            "pid": Int(snapshot.pid),
            "windowTitle": snapshot.windowTitle ?? "",
            "screenshot": snapshot.screenshotMeta.dictionary,
            "execution": [
                "strictMode": snapshot.strictMode,
                "backgroundActivated": snapshot.backgroundActivated,
                "defaultPath": snapshot.strictMode ? "accessibility_then_background_cgevent" : "accessibility_then_foreground_fallback",
            ],
            "elements": elements,
            "hint": "Use refs like {e1}. Prefer AX-capable refs; strict mode rejects foreground fallback and reports path metadata after every action.",
        ]
        if !snapshot.recentActions.isEmpty {
            result["recentActions"] = snapshot.recentActions
        }
        if !snapshot.addedLabels.isEmpty || !snapshot.removedLabels.isEmpty {
            result["stateDelta"] = ["added": snapshot.addedLabels, "removed": snapshot.removedLabels]
        }
        if let windowNumber = snapshot.windowNumber {
            result["windowNumber"] = windowNumber
        }
        return result
    }

    private func checkPermissions() -> [String: Any] {
        ComputerUsePermissions.status().dictionary
    }

    private func handleActivateApp(args: [String: Any]) -> [String: Any] {
        let name = args["name"] as? String ?? ""
        guard let app = runningApp(named: name) else {
            return ["ok": false, "error": "App '\(name)' is not running."]
        }
        app.activate()
        return ["ok": true, "app": app.localizedName ?? name]
    }

    private func handleLaunchApp(args: [String: Any]) async throws -> [String: Any] {
        let name = (args["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return ["ok": false, "error": "App name is required."] }
        if let app = runningApp(named: name) {
            app.activate()
            return ["ok": true, "app": app.localizedName ?? name, "alreadyRunning": true]
        }
        guard let appURL = applicationURL(named: name) else {
            return ["ok": false, "error": "App '\(name)' was not found."]
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        let app = try await NSWorkspace.shared.openApplication(at: appURL, configuration: config)
        return ["ok": true, "app": app.localizedName ?? name]
    }

    private func handleOpenURL(args: [String: Any]) async throws -> [String: Any] {
        guard let rawURL = args["url"] as? String, let url = URL(string: rawURL) else {
            return ["ok": false, "error": "Invalid URL."]
        }
        if let appName = args["app"] as? String, !appName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard let appURL = applicationURL(named: appName) else {
                return ["ok": false, "error": "App '\(appName)' was not found."]
            }
            _ = try await NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration())
            return ["ok": true]
        }
        return ["ok": NSWorkspace.shared.open(url)]
    }

    private func displayInfo() -> [String: Any] {
        guard let screen = NSScreen.main else { return ["ok": false, "error": "No main screen."] }
        return [
            "ok": true,
            "width": Int(screen.frame.width),
            "height": Int(screen.frame.height),
            "scale_factor": screen.backingScaleFactor,
        ]
    }

    private func cuaScreenshotResult() async throws -> [[String: Any]] {
        guard let screen = NSScreen.main else { throw ComputerUseError.screenshotFailed }
        cuaSnapshotFrontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let cgImage = await screenCaptureKitDisplayImage() ?? CGWindowListCreateImage(CGRect.null, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
        guard let cgImage else {
            throw ComputerUseError.screenshotFailed
        }
        let logicalWidth = Int(screen.frame.width)
        let logicalHeight = Int(screen.frame.height)
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: logicalWidth,
            pixelsHigh: logicalHeight,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            throw ComputerUseError.screenshotFailed
        }
        rep.size = NSSize(width: logicalWidth, height: logicalHeight)
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
            throw ComputerUseError.screenshotFailed
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
            .draw(in: NSRect(x: 0, y: 0, width: logicalWidth, height: logicalHeight))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else {
            throw ComputerUseError.screenshotFailed
        }
        return [
            ["type": "text", "text": jsonString(["ok": true, "width": logicalWidth, "height": logicalHeight]) ?? "{\"ok\":true}"],
            ["type": "image", "data": png.base64EncodedString(), "mimeType": "image/png"],
        ]
    }

    private func screenCaptureKitDisplayImage() async -> CGImage? {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { return nil }
            let configuration = SCStreamConfiguration()
            configuration.width = display.width
            configuration.height = display.height
            configuration.showsCursor = true
            let filter = SCContentFilter(display: display, excludingWindows: [])
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        } catch {
            return nil
        }
    }

    private func runningApps() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    }

    private func runningApp(named name: String) -> NSRunningApplication? {
        let needle = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return runningApps().first { $0.localizedName?.lowercased() == needle }
            ?? runningApps().first { $0.localizedName?.lowercased().contains(needle) == true }
    }

    private func applicationURL(named name: String) -> URL? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId(for: trimmed)) {
            return url
        }
        if let path = NSWorkspace.shared.fullPath(forApplication: trimmed) {
            return URL(fileURLWithPath: path)
        }
        let candidates = [
            "/Applications/\(trimmed).app",
            "/System/Applications/\(trimmed).app",
            "/Applications/Utilities/\(trimmed).app",
            NSString(string: "~/Applications/\(trimmed).app").expandingTildeInPath,
        ]
        return candidates.map(URL.init(fileURLWithPath:)).first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private func bundleId(for appName: String) -> String {
        switch appName.lowercased() {
        case "safari": return "com.apple.Safari"
        case "google chrome", "chrome": return "com.google.Chrome"
        case "arc": return "company.thebrowser.Browser"
        case "microsoft edge", "edge": return "com.microsoft.edgemac"
        case "brave", "brave browser": return "com.brave.Browser"
        case "slack": return "com.tinyspeck.slackmacgap"
        default: return ""
        }
    }

    private func cuaKeysToCombo(_ keys: [String]) -> String {
        keys.map { key in
            switch key.lowercased() {
            case "ctrl", "control": return "command"
            case "meta", "super", "win", "cmd": return "command"
            case "alt": return "option"
            case "arrowup": return "up"
            case "arrowdown": return "down"
            case "arrowleft": return "left"
            case "arrowright": return "right"
            case "backspace": return "delete"
            case " ": return "space"
            default: return key.lowercased()
            }
        }.joined(separator: "+")
    }

    private func parsePointPath(_ raw: Any?) -> [CGPoint] {
        guard let pairs = raw as? [[Any]] else { return [] }
        return pairs.compactMap { pair in
            guard pair.count >= 2 else { return nil }
            let x = valueAsDouble(pair[0])
            let y = valueAsDouble(pair[1])
            guard let x, let y else { return nil }
            return CGPoint(x: x, y: y)
        }
    }

    private func validateCuaSnapshotFresh() throws {
        guard let snapshotPID = cuaSnapshotFrontmostPID else {
            throw ComputerUseError.staleSnapshot("CUA action requires a screenshot first.")
        }
        let currentPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard currentPID == snapshotPID else {
            throw ComputerUseError.staleSnapshot("The user changed focus since the last CUA screenshot. Capture a new screenshot before acting.")
        }
    }

    private func valueAsDouble(_ value: Any) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? String { return Double(value) }
        return nil
    }

    private func respond(id: Any?, result: Any) {
        var response: [String: Any] = ["jsonrpc": "2.0", "result": result]
        if let id { response["id"] = id }
        writeLine(response)
    }

    private func respondError(id: Any?, code: Int, message: String) {
        var response: [String: Any] = ["jsonrpc": "2.0", "error": ["code": code, "message": message]]
        if let id { response["id"] = id }
        writeLine(response)
    }

    private func writeLine(_ object: [String: Any]) {
        guard let text = jsonString(object) else { return }
        print(text)
    }

    private func textResult(_ text: String) -> [[String: Any]] {
        [["type": "text", "text": text]]
    }

    private func jsonResult(_ payload: [String: Any]) -> [[String: Any]] {
        textResult(jsonString(payload) ?? "{\"ok\":false,\"error\":\"Failed to serialize result.\"}")
    }

    private func jsonString(_ value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let text = String(data: data, encoding: .utf8) else {
            return nil
        }
        return text
    }

    private func errorPayload(_ error: Error) -> [String: Any] {
        let message = error.localizedDescription
        var payload: [String: Any] = ["ok": false, "error": message]
        if case ComputerUseError.staleSnapshot = error {
            payload["staleSnapshot"] = true
            payload["retryable"] = false
            payload["requiredNextAction"] = "snapshot"
            payload["hint"] = "Take a fresh snapshot before retrying. Do not repeat the same action against stale UI state."
        }
        if message.localizedCaseInsensitiveContains("accessibility") {
            payload["permissionNeeded"] = "accessibility"
        }
        if message.localizedCaseInsensitiveContains("screenshot") || message.localizedCaseInsensitiveContains("screen recording") {
            payload["permissionNeeded"] = "screen-recording"
        }
        return payload
    }

    private func log(_ message: String) {
        fputs("[ComputerUse] \(message)\n", stderr)
    }

    private func intArg(_ args: [String: Any], _ key: String) -> Int? {
        if let value = args[key] as? Int { return value }
        if let value = args[key] as? Double { return Int(value) }
        if let value = args[key] as? String { return Int(value) }
        return nil
    }

    private func doubleArg(_ args: [String: Any], _ key: String) -> Double? {
        if let value = args[key] as? Double { return value }
        if let value = args[key] as? Int { return Double(value) }
        if let value = args[key] as? String { return Double(value) }
        return nil
    }

    private func boolArg(_ args: [String: Any], _ key: String) -> Bool? {
        if let value = args[key] as? Bool { return value }
        if let value = args[key] as? String {
            if value == "true" { return true }
            if value == "false" { return false }
        }
        return nil
    }

    private func snapshotIDArg(_ args: [String: Any]) -> String? {
        args["snapshot_id"] as? String ?? args["snapshotId"] as? String
    }
}
