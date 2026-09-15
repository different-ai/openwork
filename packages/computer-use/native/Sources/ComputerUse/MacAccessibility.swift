import AppKit
import ApplicationServices
import ScreenCaptureKit
import CryptoKit

struct AppIdentity {
    let app: NSRunningApplication
    let bundleID: String
    let executable: URL
    let launched: ProcessStart
    // Launch Services may omit launchDate for directly launched apps. The
    // kernel start time still prevents a recycled PID from inheriting a grant.
    struct ProcessStart: Equatable {
        let seconds: UInt64
        let microseconds: UInt64
        init?(pid: pid_t) {
            var info = proc_bsdinfo()
            let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
            seconds = info.pbi_start_tvsec; microseconds = info.pbi_start_tvusec
        }
    }
    var pid: pid_t { app.processIdentifier }
    var name: String { app.localizedName ?? bundleID }

    static func resolve(_ bundleID: String, pid: pid_t?) throws -> AppIdentity {
        let matches = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier == bundleID && $0.activationPolicy == .regular && (pid == nil || $0.processIdentifier == pid)
        }
        guard matches.count == 1, let app = matches.first, let executable = app.executableURL, let launched = ProcessStart(pid: app.processIdentifier) else {
            throw UseError("app_unavailable", "Choose an exact running app from computer_discover; supply its pid if several copies are open.", next: "discover")
        }
        guard isAllowed(app) else { throw UseError("protected_app", "This app cannot be operated through Computer Use.", next: "use_structured_tool") }
        return AppIdentity(app: app, bundleID: bundleID, executable: executable, launched: launched)
    }
    @MainActor static func open(_ bundleID: String, pid: pid_t?) async throws -> AppIdentity {
        guard isAllowed(bundleID: bundleID) else { throw UseError("protected_app", "This app cannot be operated through Computer Use.", next: "use_structured_tool") }
        // A PID pins a running instance. Never replace it with a newly launched app.
        if pid != nil || NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).count > 0 {
            let identity = try resolve(bundleID, pid: pid)
            identity.app.unhide()
            return identity
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID),
              Bundle(url: url)?.bundleIdentifier == bundleID else {
            throw UseError("app_unavailable", "This app is not installed. Choose an app from computer_discover.", next: "discover")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        let launched = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
        // Launch Services can complete before the app enters its UI run loop.
        for _ in 0..<30 {
            try Task.checkCancellation()
            if let identity = try? resolve(bundleID, pid: launched.processIdentifier) { return identity }
            if launched.isTerminated { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        return try resolve(bundleID, pid: launched.processIdentifier)
    }
    static func installedApps() -> [[String: Any]] {
        // Enumerate app bundles only, never documents or window content.
        let roots = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
                     NSHomeDirectory() + "/Applications"]
        var apps: [String: String] = [:]
        for root in roots {
            for url in (try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? [] {
                guard url.pathExtension == "app", let bundle = Bundle(url: url), let id = bundle.bundleIdentifier,
                      isAllowed(bundleID: id) else { continue }
                apps[id] = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                    ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? url.deletingPathExtension().lastPathComponent
            }
        }
        return apps.map { ["app_id": $0.key, "name": $0.value] }
    }
    func validate() throws {
        guard !app.isTerminated, let current = NSRunningApplication(processIdentifier: pid),
              current.bundleIdentifier == bundleID, current.executableURL == executable, ProcessStart(pid: pid) == launched,
              Self.isAllowed(current) else {
            throw UseError("app_changed", "The approved app exited or changed. Open a new session.", next: "open_session")
        }
    }
    static func isAllowed(_ app: NSRunningApplication) -> Bool {
        guard let id = app.bundleIdentifier, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return false }
        return isAllowed(bundleID: id)
    }
    static func isAllowed(bundleID id: String) -> Bool {
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

    var labelHash: Data? = nil
    var valueHash: Data? = nil

    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]
    var textField: Bool { Self.textRoles.contains(role) && enabled && !protected }

    static let interactiveRoles: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXLink", "AXSlider", "AXIncrementor", "AXMenuItem", "AXMenuBarItem",
        "AXDisclosureTriangle", "AXColorWell", "AXSwitch", "AXToggle", "AXTab", "AXCell", "AXRow", "AXOutlineRow", "AXDockItem", "AXHandle"]
    var interactive: Bool { !actions.isEmpty || settable || Self.interactiveRoles.contains(role) }

    func payload(bounds: CGRect, width: Int, height: Int, compact: Bool) throws -> [String: Any] {
        guard Geometry.valid(frame), Geometry.valid(bounds), (1...1_000_000).contains(width), (1...1_000_000).contains(height) else {
            throw UseError("invalid_geometry", "The observation geometry is invalid.", next: "observe")
        }
        let x = (frame.minX - bounds.minX) * Double(width) / bounds.width
        let y = (frame.minY - bounds.minY) * Double(height) / bounds.height
        let w = frame.width * Double(width) / bounds.width
        let h = frame.height * Double(height) / bounds.height
        guard [x, y, w, h].allSatisfy({ $0.isFinite && abs($0) < 1_000_000_000_000 }) else {
            throw UseError("invalid_geometry", "The observation coordinates cannot be represented safely.", next: "observe")
        }
        var result: [String: Any]
        if compact {
            result = ["ref": ref, "role": role.hasPrefix("AX") ? String(role.dropFirst(2)) : role,
                "x": Int(x.rounded()), "y": Int(y.rounded()), "w": Int(w.rounded()), "h": Int(h.rounded())]
            if !label.isEmpty { result["label"] = label }
            if !actions.isEmpty { result["press"] = true }
            if settable { result["settable"] = true }
            if !enabled { result["disabled"] = true }
        } else {
            result = ["ref": ref, "role": role, "label": label, "enabled": enabled,
                "actions": actions.isEmpty ? [] : ["press"], "settable": settable,
                "bounds": ["x": x, "y": y, "width": w, "height": h]]
        }
        if let value { result["value"] = value }
        return result
    }
}

struct WindowState {
    let records: [ElementRecord]
    let visited: Int
    let truncated: Bool
    let protectedFrames: [CGRect]
    var privacyIssue: String? = nil
    var focused: AXUIElement? = nil

    var focusRecord: ElementRecord? { records.first { record in focused.map { CFEqual($0, record.element) } == true } }
    func requireCapture() throws {
        guard !truncated, privacyIssue == nil, protectedFrames.allSatisfy({ Geometry.valid($0) }),
              records.allSatisfy({ Geometry.valid($0.frame) }) else {
            throw UseError("privacy_incomplete", "The accessibility privacy scan is incomplete or has invalid masks. No screenshot was captured; use the available text or observe again.", next: "observe")
        }
    }
}

struct AXReadBudget {
    let deadline: TimeInterval
    private let clock: () -> TimeInterval
    init(seconds: TimeInterval = 0.35, clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.clock = clock; deadline = clock() + seconds
    }
    func timeout() throws -> Float {
        try Task.checkCancellation()
        let remaining = deadline - clock()
        guard remaining >= 0.001 else { throw UseError("accessibility_timeout", "The bounded accessibility read did not finish. Observe again or take over.", next: "observe") }
        return Float(min(0.05, remaining))
    }
    func check() throws { _ = try timeout() }
}

@MainActor
final class MacAccessibility {
    func windows(_ app: AppIdentity) async throws -> [WindowTarget] {
        try requirePermissions()
        try app.validate()
        let root = AXUIElementCreateApplication(app.pid)
        AXUIElementSetMessagingTimeout(root, 0.2)
        // Electron exposes its accessibility tree on demand. This is its
        // documented assistive-technology handshake, not a macOS permission grant.
        // Native apps can reject the optional attribute and still expose windows.
        if (attribute(root, "AXManualAccessibility") as? Bool) == false,
           AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
            // Electron debounces activation for two seconds. Do not keep setting
            // the attribute during retries: that restarts its countdown.
            let deadline = ProcessInfo.processInfo.systemUptime + 3
            while ProcessInfo.processInfo.systemUptime < deadline {
                try app.validate()
                if (attribute(root, "AXManualAccessibility") as? Bool) == true { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        for attempt in 0..<5 {
            let axWindows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            try app.validate()
            let targets: [WindowTarget] = content.windows.compactMap { window in
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
            if !targets.isEmpty { return targets }
            // WindowServer and Accessibility can report different frames during
            // opening animation. Refresh reads briefly; never guess or dispatch input.
            if attempt < 4 { try await Task.sleep(nanoseconds: 100_000_000) }
        }
        return []
    }

    func validate(_ target: WindowTarget, app: AppIdentity, requireFrontmost: Bool = false) throws -> CGRect {
        try requirePermissions()
        try app.validate()
        let budget = AXReadBudget()
        var pid: pid_t = 0
        guard AXUIElementGetPid(target.element, &pid) == .success, pid == app.pid,
              let bounds = try checkedFrame(target.element, budget), bounds.width > 20, bounds.height > 20,
              try checkedBool(target.element, kAXMinimizedAttribute, budget) != true,
              let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, target.id) as? [[String: Any]],
              info.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == app.pid
                  && ($0[kCGWindowIsOnscreen as String] as? Bool) == true }) else {
            throw UseError("window_unavailable", "The approved window is closed, minimized, or no longer on this desktop.", next: "human_takeover")
        }
        if requireFrontmost {
            let root = AXUIElementCreateApplication(app.pid)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid,
                   let focused = try checkedElement(root, kAXFocusedWindowAttribute, budget), CFEqual(focused, target.element) else {
                throw UseError("window_not_frontmost", "Choose Continue in the Computer Use controls to return to the approved window.", next: "human_takeover")
            }
        }
        return bounds
    }

    func read(_ target: WindowTarget, budget: AXReadBudget = AXReadBudget(seconds: 2), check: () throws -> Void = {}) async throws -> WindowState {
        var records: [ElementRecord] = []
        var protectedFrames: [CGRect] = []
        var visited: Set<AXUIElement> = []
        var pending = [(target.element, 0)]
        var issue: String?
        var focused: AXUIElement?
        while let (element, depth) = pending.popLast() {
            try Task.checkCancellation(); try check()
            guard depth < 24, visited.count < 1500, records.count < 300 else { issue = "tree_limit"; break }
            guard visited.insert(element).inserted else { continue }
            do {
                try budget.check()
                guard let role = try checkedString(element, kAXRoleAttribute, budget) else {
                    throw UseError("accessibility_unavailable", "An accessible role could not be verified.", next: "observe")
                }
                let secure = try isProtected(element, budget)
                let bounds = try checkedFrame(element, budget)
                if secure {
                    guard let bounds, Geometry.valid(bounds) else {
                        throw UseError("missing_secure_mask", "A protected control has no usable mask.", next: "observe")
                    }
                    protectedFrames.append(bounds)
                } else {
                    let label = try checkedString(element, kAXTitleAttribute, budget)
                        ?? checkedString(element, kAXDescriptionAttribute, budget) ?? ""
                    let value = try checkedString(element, kAXValueAttribute, budget)
                    let actions = try actionNames(element, budget)
                    let settable = try valueSettable(element, budget)
                    let enabled = try checkedBool(element, kAXEnabledAttribute, budget) != false
                    if let bounds, Geometry.valid(bounds), !label.isEmpty || !(value ?? "").isEmpty || !actions.isEmpty || settable || ElementRecord.interactiveRoles.contains(role) {
                        records.append(ElementRecord(ref: "e\(records.count + 1)", element: element, role: role,
                            label: String(label.prefix(180)), value: value.map { String($0.prefix(500)) }, frame: bounds,
                            actions: actions, settable: settable, enabled: enabled, protected: false,
                            labelHash: textHash(label), valueHash: value.map(textHash)))
                    }
                    let descendants = try await children(element, limit: 1500 - visited.count - pending.count, budget: budget, check: check)
                    if descendants.truncated { issue = "tree_limit" }
                    pending += descendants.elements.reversed().map { ($0, depth + 1) }
                }
            } catch is CancellationError { throw CancellationError() }
            catch {
                issue = (error as? UseError)?.code ?? "accessibility_unavailable"
                break
            }
            await Task.yield()
        }
        try check()
        if issue == nil {
            do {
                var pid: pid_t = 0
                guard AXUIElementGetPid(target.element, &pid) == .success else { throw UseError("window_unavailable", "The window exited.", next: "observe") }
                focused = try checkedElement(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute, budget)
            } catch is CancellationError { throw CancellationError() }
            catch { issue = (error as? UseError)?.code ?? "accessibility_unavailable" }
        }
        try check()
        return WindowState(records: records, visited: visited.count, truncated: issue != nil,
            protectedFrames: protectedFrames, privacyIssue: issue, focused: focused)
    }

    func validateRecord(_ record: ElementRecord, target: WindowTarget) throws {
        let budget = AXReadBudget()
        try validateAncestry(record.element, target: target, budget: budget)
        let label = try checkedString(record.element, kAXTitleAttribute, budget)
            ?? checkedString(record.element, kAXDescriptionAttribute, budget) ?? ""
        let value = try checkedString(record.element, kAXValueAttribute, budget)
        guard !record.protected, record.enabled,
              try checkedFrame(record.element, budget) == record.frame,
              try checkedString(record.element, kAXRoleAttribute, budget) == record.role,
              textHash(label) == (record.labelHash ?? textHash(record.label)),
              value.map(textHash) == (record.valueHash ?? record.value.map(textHash)),
              try checkedBool(record.element, kAXEnabledAttribute, budget) != false,
              try actionNames(record.element, budget) == record.actions,
              try valueSettable(record.element, budget) == record.settable else {
            throw UseError("stale_element", "The exact accessible element changed or is unavailable. Observe again.", next: "observe")
        }
    }

    func captureDigest(_ state: WindowState) throws -> Data {
        guard state.records.allSatisfy({ Geometry.valid($0.frame) }), state.protectedFrames.allSatisfy({ Geometry.valid($0) }) else {
            throw UseError("invalid_geometry", "The accessible geometry is not safe to capture or act on.", next: "observe")
        }
        let records: [[String: Any]] = state.records.map { record in
            ["identity": CFHash(record.element), "role": record.role,
             "label": (record.labelHash ?? textHash(record.label)).base64EncodedString(),
             "value": (record.valueHash ?? record.value.map(textHash)).map { $0.base64EncodedString() as Any } ?? NSNull(),
             "frame": [record.frame.minX, record.frame.minY, record.frame.width, record.frame.height],
             "enabled": record.enabled, "actions": record.actions, "settable": record.settable]
        }
        let secure = state.protectedFrames.map { [$0.minX, $0.minY, $0.width, $0.height] }
        let data = try JSONSerialization.data(withJSONObject: ["records": records, "secure": secure, "truncated": state.truncated,
            "privacy_issue": state.privacyIssue as Any? ?? NSNull(), "focus": state.focused.map { CFHash($0) as Any } ?? NSNull()], options: [.sortedKeys])
        return Data(SHA256.hash(data: data))
    }
    func imageDigest(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
    private func textHash(_ text: String) -> Data { Data(SHA256.hash(data: Data(text.utf8))) }

    @discardableResult
    func checkHit(_ point: CGPoint, target: WindowTarget, app: AppIdentity, expected: AXUIElement? = nil) throws -> AXUIElement {
        let budget = AXReadBudget()
        let root = AXUIElementCreateSystemWide()
        try prepare(root, budget)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &hit) == .success,
              let hit else { throw UseError("unverified_target", "This position cannot be verified as part of the approved window.", next: "observe") }
        var pid: pid_t = 0
        guard AXUIElementGetPid(hit, &pid) == .success, pid == app.pid,
              expected.map({ CFEqual($0, hit) }) ?? true else {
            throw UseError("stale_element", "The pointer target changed or is covered. Observe again.", next: "observe")
        }
        try validateAncestry(hit, target: target, budget: budget)
        return hit
    }

    func checkFocus(_ expected: ElementRecord?, target: WindowTarget, app: AppIdentity, requireField: Bool) throws {
        guard let expected, !expected.protected, expected.enabled, !requireField || expected.textField else {
            throw UseError("focus_required", "Observe a focused normal text field or control before using the keyboard.", next: "observe")
        }
        let budget = AXReadBudget()
        let root = AXUIElementCreateApplication(app.pid)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid,
              let window = try checkedElement(root, kAXFocusedWindowAttribute, budget), CFEqual(window, target.element),
              let focused = try checkedElement(root, kAXFocusedUIElementAttribute, budget), CFEqual(focused, expected.element),
              try checkedString(focused, kAXRoleAttribute, budget) == expected.role,
              try checkedFrame(focused, budget) == expected.frame,
              try checkedBool(focused, kAXEnabledAttribute, budget) != false else {
            throw UseError("focus_changed", "The exact observed keyboard target changed. Observe again before typing or pressing keys.", next: "observe")
        }
        try validateAncestry(focused, target: target, budget: budget)
        if requireField, try checkedBool(focused, "AXEditable", budget) == false {
            throw UseError("protected_input", "The observed field is not editable.", next: "observe")
        }
    }

    private func validateAncestry(_ element: AXUIElement, target: WindowTarget, budget: AXReadBudget) throws {
        var current: AXUIElement? = element
        var visited: Set<AXUIElement> = []
        var owner: pid_t = 0
        guard AXUIElementGetPid(target.element, &owner) == .success else { throw UseError("window_unavailable", "The approved window exited.", next: "observe") }
        while let node = current, visited.count < 24, visited.insert(node).inserted {
            try budget.check()
            var pid: pid_t = 0
            guard AXUIElementGetPid(node, &pid) == .success, pid == owner else {
                throw UseError("outside_window", "The target belongs to another app.", next: "human_takeover")
            }
            guard try !isProtected(node, budget) else {
                throw UseError("protected_input", "This control or an ancestor contains protected content. Take over for this step.", next: "human_takeover")
            }
            if CFEqual(node, target.element) { return }
            if let window = try checkedElement(node, kAXWindowAttribute, budget), !CFEqual(window, target.element) {
                throw UseError("outside_window", "The target belongs to another window.", next: "human_takeover")
            }
            current = try checkedElement(node, kAXParentAttribute, budget)
        }
        throw UseError("unverified_target", "The target's protected ancestry could not be verified inside the approved window.", next: "observe")
    }

    func capture(target: WindowTarget, app: AppIdentity, bounds: CGRect, state: WindowState,
                 check: () throws -> Void = {}) async throws -> (Data, Int, Int, Int64) {
        try state.requireCapture()
        guard Geometry.valid(bounds) else { throw UseError("invalid_geometry", "The window has invalid capture bounds.", next: "observe") }
        try Task.checkCancellation(); try check()
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        try check()
        guard let window = content.windows.first(where: { $0.windowID == target.id && $0.owningApplication?.processID == app.pid }),
              window.frame == bounds else { throw UseError("stale_observation", "The selected window moved before capture.", next: "observe") }
        let config = SCStreamConfiguration()
        let ratio = min(1, 1600 / max(bounds.width, bounds.height))
        config.width = max(1, Int(bounds.width * ratio))
        config.height = max(1, Int(bounds.height * ratio))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
        let capturedAt = Int64(Date().timeIntervalSince1970 * 1000)
        try Task.checkCancellation(); try check()
        let after = try await read(target, check: check)
        try after.requireCapture()
        guard try captureDigest(state) == captureDigest(after), try validate(target, app: app) == bounds else {
            throw UseError("stale_observation", "The window's content, focus or privacy masks changed during capture.", next: "observe")
        }
        try check()
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
        return (data, image.width, image.height, capturedAt)
    }

    func requirePermissions() throws {
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
            throw UseError("permissions_required", "Open Computer Use settings and grant Accessibility and Screen Recording yourself.", next: "human_takeover")
        }
    }
    private func prepare(_ element: AXUIElement, _ budget: AXReadBudget) throws {
        guard AXUIElementSetMessagingTimeout(element, try budget.timeout()) == .success else {
            throw UseError("accessibility_unavailable", "Could not bound this accessibility operation.", next: "observe")
        }
    }
    private func accepted(_ result: AXError, _ budget: AXReadBudget) throws -> Bool {
        try budget.check()
        if result == .success { return true }
        if result == .attributeUnsupported || result == .noValue { return false }
        throw UseError("accessibility_unavailable", "An accessibility read failed; its content or privacy state is unverified.", next: "observe")
    }
    private func checkedAttribute(_ element: AXUIElement, _ name: String, _ budget: AXReadBudget) throws -> CFTypeRef? {
        try prepare(element, budget)
        var value: CFTypeRef?
        return try accepted(AXUIElementCopyAttributeValue(element, name as CFString, &value), budget) ? value : nil
    }
    private func checkedElement(_ element: AXUIElement, _ name: String, _ budget: AXReadBudget) throws -> AXUIElement? {
        guard let value = try checkedAttribute(element, name, budget) else { return nil }
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else { throw UseError("accessibility_unavailable", "An accessibility target has an invalid type.", next: "observe") }
        return (value as! AXUIElement)
    }
    private func checkedString(_ element: AXUIElement, _ name: String, _ budget: AXReadBudget) throws -> String? {
        guard let value = try checkedAttribute(element, name, budget) else { return nil }
        if let string = value as? String { return string }
        if name == kAXValueAttribute {
            if let number = value as? NSNumber { return number.stringValue }
            return nil
        }
        throw UseError("accessibility_unavailable", "An accessibility identity or protection attribute has an invalid type.", next: "observe")
    }
    private func checkedBool(_ element: AXUIElement, _ name: String, _ budget: AXReadBudget) throws -> Bool? {
        guard let value = try checkedAttribute(element, name, budget) else { return nil }
        guard CFGetTypeID(value) == CFBooleanGetTypeID(), let flag = value as? Bool else {
            throw UseError("accessibility_unavailable", "An accessibility protection or enablement flag has an invalid type.", next: "observe")
        }
        return flag
    }
    private func isProtected(_ element: AXUIElement, _ budget: AXReadBudget) throws -> Bool {
        try checkedString(element, kAXSubroleAttribute, budget) == "AXSecureTextField"
            || checkedBool(element, "AXProtectedContent", budget) == true
    }
    private func actionNames(_ element: AXUIElement, _ budget: AXReadBudget) throws -> [String] {
        try prepare(element, budget)
        var names: CFArray?
        let result = AXUIElementCopyActionNames(element, &names)
        if result == .notImplemented { try budget.check(); return [] }
        guard try accepted(result, budget) else { return [] }
        guard let names = names as? [String] else { throw UseError("accessibility_unavailable", "Accessible actions could not be verified.", next: "observe") }
        return names.filter { $0 == kAXPressAction }
    }
    func valueSettable(_ element: AXUIElement, _ budget: AXReadBudget = AXReadBudget()) throws -> Bool {
        try prepare(element, budget)
        var settable = DarwinBoolean(false)
        return try accepted(AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable), budget) && settable.boolValue
    }
    private func children(_ element: AXUIElement, limit: Int, budget: AXReadBudget, check: () throws -> Void) async throws -> (elements: [AXUIElement], truncated: Bool) {
        try prepare(element, budget)
        var total = 0
        guard try accepted(AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &total), budget) else { return ([], false) }
        guard total >= 0 else { throw UseError("accessibility_unavailable", "The accessible child count is invalid.", next: "observe") }
        let count = min(total, max(0, limit))
        var elements: [AXUIElement] = []
        while elements.count < count {
            try check(); try prepare(element, budget)
            let size = min(64, count - elements.count)
            var values: CFArray?
            guard try accepted(AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, elements.count, size, &values), budget),
                  let page = values as? [AXUIElement], page.count == size else {
                throw UseError("stale_observation", "The accessible children changed during the bounded read.", next: "observe")
            }
            elements += page
            await Task.yield()
        }
        return (elements, count != total)
    }
    private func checkedFrame(_ element: AXUIElement, _ budget: AXReadBudget) throws -> CGRect? {
        guard let rawPosition = try checkedAttribute(element, kAXPositionAttribute, budget),
              let rawSize = try checkedAttribute(element, kAXSizeAttribute, budget) else { return nil }
        guard CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else {
            throw UseError("invalid_geometry", "The accessible geometry has an invalid type.", next: "observe")
        }
        let position = rawPosition as! AXValue
        let size = rawSize as! AXValue
        var point = CGPoint.zero; var dimensions = CGSize.zero
        guard AXValueGetType(position) == .cgPoint, AXValueGetType(size) == .cgSize,
              AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions),
              Geometry.valid(CGRect(origin: point, size: dimensions), allowEmpty: true) else {
            throw UseError("invalid_geometry", "The accessible geometry is invalid or outside safe bounds.", next: "observe")
        }
        return CGRect(origin: point, size: dimensions)
    }
    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? { try? checkedAttribute(element, name, AXReadBudget()) }
    func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? { try? checkedElement(element, name, AXReadBudget()) }
    func frame(_ element: AXUIElement) -> CGRect? { try? checkedFrame(element, AXReadBudget()) }
}
