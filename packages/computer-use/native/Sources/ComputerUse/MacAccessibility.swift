import AppKit
import ApplicationServices
import ScreenCaptureKit
import CryptoKit

struct AppIdentity {
    let app: NSRunningApplication
    let bundleID: String
    let executable: URL
    let launched: Date
    var pid: pid_t { app.processIdentifier }
    var name: String { app.localizedName ?? bundleID }

    static func resolve(_ bundleID: String, pid: pid_t?) throws -> AppIdentity {
        let matches = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier == bundleID && $0.activationPolicy == .regular && (pid == nil || $0.processIdentifier == pid)
        }
        guard matches.count == 1, let app = matches.first, let executable = app.executableURL, let launched = app.launchDate else {
            throw UseError("app_unavailable", "Choose an exact running app from computer_discover; supply its pid if several copies are open.", next: "discover")
        }
        guard isAllowed(app) else { throw UseError("protected_app", "This app cannot be operated through Computer Use.", next: "use_structured_tool") }
        return AppIdentity(app: app, bundleID: bundleID, executable: executable, launched: launched)
    }
    func validate() throws {
        guard !app.isTerminated, let current = NSRunningApplication(processIdentifier: pid),
              current.bundleIdentifier == bundleID, current.executableURL == executable, current.launchDate == launched,
              Self.isAllowed(current) else {
            throw UseError("app_changed", "The approved app exited or changed. Open a new session.", next: "open_session")
        }
    }
    static func isAllowed(_ app: NSRunningApplication) -> Bool {
        guard let id = app.bundleIdentifier, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return false }
        // These surfaces can change the permission boundary or execute arbitrary commands.
        let protected: Set<String> = ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
            "com.mitchellh.ghostty", "com.apple.ScriptEditor2", "com.apple.systempreferences",
            "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.keychainaccess",
            "com.apple.Passwords", "com.1password.1password", "com.agilebits.onepassword7"]
        return !protected.contains(id) && !id.hasPrefix("com.differentai.openwork")
            && !id.hasPrefix("com.openwork") && !id.hasPrefix("com.openai")
    }
}

struct WindowTarget {
    let id: CGWindowID
    let title: String
    let element: AXUIElement
    let frame: CGRect
}

struct ElementRecord {
    let ref: String
    let element: AXUIElement
    let role: String
    let label: String
    let value: String?
    let frame: CGRect
    let actions: [String]
    let settable: Bool
    let enabled: Bool
    let protected: Bool
}

struct WindowState {
    let records: [ElementRecord]
    let visited: Int
    let truncated: Bool
    let protectedFrames: [CGRect]
}

@MainActor
final class MacAccessibility {
    func windows(_ app: AppIdentity) async throws -> [WindowTarget] {
        try requirePermissions()
        try app.validate()
        let root = AXUIElementCreateApplication(app.pid)
        AXUIElementSetMessagingTimeout(root, 0.2)
        let axWindows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        try app.validate()
        return content.windows.compactMap { window in
            guard window.owningApplication?.processID == app.pid, window.windowLayer == 0,
                  window.frame.width > 20, window.frame.height > 20 else { return nil }
            let matches = axWindows.filter { element in
                guard let bounds = frame(element) else { return false }
                return abs(bounds.minX - window.frame.minX) < 2 && abs(bounds.minY - window.frame.minY) < 2
                    && abs(bounds.width - window.frame.width) < 2 && abs(bounds.height - window.frame.height) < 2
            }
            // Never guess a window from a repeated title or take the first match.
            guard matches.count == 1, let element = matches.first else { return nil }
            AXUIElementSetMessagingTimeout(element, 0.2)
            return WindowTarget(id: window.windowID, title: window.title ?? "Untitled window", element: element, frame: window.frame)
        }.sorted { $0.id < $1.id }
    }

    func validate(_ target: WindowTarget, app: AppIdentity, requireFrontmost: Bool = false) throws -> CGRect {
        try requirePermissions()
        try app.validate()
        var pid: pid_t = 0
        guard AXUIElementGetPid(target.element, &pid) == .success, pid == app.pid,
              let bounds = frame(target.element), bounds.width > 20, bounds.height > 20,
              (attribute(target.element, kAXMinimizedAttribute) as? Bool) != true,
              let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, target.id) as? [[String: Any]],
              info.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == app.pid
                  && ($0[kCGWindowIsOnscreen as String] as? Bool) == true }) else {
            throw UseError("window_unavailable", "The approved window is closed, minimized, or no longer on this desktop.", next: "human_takeover")
        }
        if requireFrontmost {
            let root = AXUIElementCreateApplication(app.pid)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid,
                  let focused = elementAttribute(root, kAXFocusedWindowAttribute), CFEqual(focused, target.element) else {
                throw UseError("window_not_frontmost", "Bring the approved window to the front, then resume in the Computer Use panel.", next: "human_takeover")
            }
        }
        return bounds
    }

    func read(_ target: WindowTarget) -> WindowState {
        var records: [ElementRecord] = []
        var protectedFrames: [CGRect] = []
        var visited: Set<AXUIElement> = []
        var truncated = false
        let started = ProcessInfo.processInfo.systemUptime
        func walk(_ element: AXUIElement, depth: Int) {
            guard depth < 24, visited.count < 1500, records.count < 300,
                  ProcessInfo.processInfo.systemUptime - started < 2 else { truncated = true; return }
            guard visited.insert(element).inserted else { return }
            let role = string(element, kAXRoleAttribute) ?? "AXUnknown"
            let secure = string(element, kAXSubroleAttribute) == "AXSecureTextField"
                || (attribute(element, "AXProtectedContent") as? Bool) == true
            let bounds = frame(element)
            if secure {
                if let bounds { protectedFrames.append(bounds) }
                // Do not read protected values, labels, descriptions, or descendants.
                return
            }
            let label = String((string(element, kAXTitleAttribute) ?? string(element, kAXDescriptionAttribute) ?? "").prefix(180))
            let value = string(element, kAXValueAttribute).map { String($0.prefix(500)) }
            var actionValues: CFArray?
            AXUIElementCopyActionNames(element, &actionValues)
            let actions = (actionValues as? [String] ?? []).filter { $0 == kAXPressAction }
            var settable = DarwinBoolean(false)
            AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
            let enabled = (attribute(element, kAXEnabledAttribute) as? Bool) != false
            if let bounds, bounds.width > 0, bounds.height > 0,
               !label.isEmpty || !(value ?? "").isEmpty || !actions.isEmpty || settable.boolValue {
                records.append(ElementRecord(ref: "e\(records.count + 1)", element: element, role: role,
                    label: label, value: value, frame: bounds, actions: actions,
                    settable: settable.boolValue, enabled: enabled, protected: false))
            }
            let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            for child in children { walk(child, depth: depth + 1) }
        }
        walk(target.element, depth: 0)
        return WindowState(records: records, visited: visited.count, truncated: truncated, protectedFrames: protectedFrames)
    }

    func validateRecord(_ record: ElementRecord, target: WindowTarget) throws {
        guard !record.protected, record.enabled,
              string(record.element, kAXSubroleAttribute) != "AXSecureTextField",
              (attribute(record.element, "AXProtectedContent") as? Bool) != true,
              let window = elementAttribute(record.element, kAXWindowAttribute), CFEqual(window, target.element),
              frame(record.element) == record.frame,
              string(record.element, kAXRoleAttribute) == record.role,
              String((string(record.element, kAXTitleAttribute) ?? string(record.element, kAXDescriptionAttribute) ?? "").prefix(180)) == record.label,
              string(record.element, kAXValueAttribute).map({ String($0.prefix(500)) }) == record.value,
              (attribute(record.element, kAXEnabledAttribute) as? Bool) != false else {
            throw UseError("stale_element", "The exact accessible element changed or is unavailable. Observe again.", next: "observe")
        }
    }

    func digest(_ state: WindowState) -> Data {
        let records: [[String: Any]] = state.records.map { record in
            ["role": record.role, "label": record.label, "value": record.value ?? NSNull(),
             "frame": [record.frame.minX, record.frame.minY, record.frame.width, record.frame.height],
             "enabled": record.enabled, "actions": record.actions, "settable": record.settable]
        }
        let secure = state.protectedFrames.map { [$0.minX, $0.minY, $0.width, $0.height] }
        let data = try! JSONSerialization.data(withJSONObject: ["records": records, "secure": secure, "truncated": state.truncated], options: [.sortedKeys])
        return Data(SHA256.hash(data: data))
    }
    func imageDigest(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    func checkHit(_ point: CGPoint, target: WindowTarget, app: AppIdentity) throws {
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
              let hit else { throw UseError("unverified_target", "This position cannot be verified as part of the approved window.", next: "observe") }
        var pid: pid_t = 0
        let window = elementAttribute(hit, kAXWindowAttribute)
        guard AXUIElementGetPid(hit, &pid) == .success, pid == app.pid,
              CFEqual(hit, target.element) || (window.map { CFEqual($0, target.element) } == true),
              string(hit, kAXSubroleAttribute) != "AXSecureTextField",
              (attribute(hit, "AXProtectedContent") as? Bool) != true else {
            throw UseError("outside_window", "The position is covered by another window or a protected field.", next: "human_takeover")
        }
    }

    func checkFocusedField(target: WindowTarget, app: AppIdentity) throws {
        let root = AXUIElementCreateApplication(app.pid)
        guard let focused = elementAttribute(root, kAXFocusedUIElementAttribute),
              let window = elementAttribute(focused, kAXWindowAttribute), CFEqual(window, target.element),
              string(focused, kAXSubroleAttribute) != "AXSecureTextField",
              (attribute(focused, "AXProtectedContent") as? Bool) != true else {
            throw UseError("protected_input", "Focus a normal control in the approved window. Enter passwords yourself.", next: "human_takeover")
        }
    }

    func capture(target: WindowTarget, app: AppIdentity, bounds: CGRect, state: WindowState) async throws -> (Data, Int, Int) {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == target.id && $0.owningApplication?.processID == app.pid }),
              window.frame == bounds else { throw UseError("stale_observation", "The selected window moved before capture.", next: "observe") }
        let config = SCStreamConfiguration()
        let ratio = min(1, 1600 / max(bounds.width, bounds.height))
        config.width = max(1, Int(bounds.width * ratio))
        config.height = max(1, Int(bounds.height * ratio))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
        // Capture only the window; a failure never broadens into a display capture.
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw UseError("capture_failed", "Could not encode this window.", next: "observe")
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.setFillColor(CGColor(gray: 0.15, alpha: 1))
        for rect in state.protectedFrames {
            let clipped = rect.intersection(bounds)
            guard !clipped.isNull, !clipped.isEmpty else { continue }
            let xScale = CGFloat(image.width) / bounds.width
            let yScale = CGFloat(image.height) / bounds.height
            context.fill(CGRect(x: (clipped.minX - bounds.minX) * xScale,
                y: CGFloat(image.height) - (clipped.maxY - bounds.minY) * yScale,
                width: clipped.width * xScale, height: clipped.height * yScale).insetBy(dx: -2, dy: -2))
        }
        guard let redacted = context.makeImage(), let data = NSBitmapImageRep(cgImage: redacted).representation(using: .png, properties: [:]) else {
            throw UseError("capture_failed", "Could not encode this window.", next: "observe")
        }
        return (data, image.width, image.height)
    }

    func requirePermissions() throws {
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
            throw UseError("permissions_required", "Open Computer Use settings and grant Accessibility and Screen Recording yourself.", next: "human_takeover")
        }
    }
    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement) // Core Foundation type ID checked above.
    }
    func string(_ element: AXUIElement, _ name: String) -> String? {
        let value = attribute(element, name)
        if let string = value as? String { return string }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }
    func frame(_ element: AXUIElement) -> CGRect? {
        guard let rawPosition = attribute(element, kAXPositionAttribute), CFGetTypeID(rawPosition) == AXValueGetTypeID(),
              let rawSize = attribute(element, kAXSizeAttribute), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
        let position = rawPosition as! AXValue
        let size = rawSize as! AXValue
        guard AXValueGetType(position) == .cgPoint, AXValueGetType(size) == .cgSize else { return nil }
        var point = CGPoint.zero; var dimensions = CGSize.zero
        guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions) else { return nil }
        return CGRect(origin: point, size: dimensions)
    }
}
