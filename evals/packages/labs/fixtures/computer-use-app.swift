import AppKit
import ApplicationServices

@MainActor
final class DragSurface: NSView {
    var downs = 0
    var moves = 0
    var ups = 0
    override func mouseDown(with event: NSEvent) { downs += 1 }
    override func mouseDragged(with event: NSEvent) { moves += 1 }
    override func mouseUp(with event: NSEvent) { ups += 1 }
}

@MainActor
final class RefreshLabel: NSTextField {
    var remainingChanges = 0
    var reads = 0
    override func accessibilityValue() -> String? {
        reads += 1
        if remainingChanges != 0 {
            if remainingChanges > 0 { remainingChanges -= 1 }
            stringValue = remainingChanges == 0 ? "Ready after refresh" : "Updating \(reads)"
        }
        return super.accessibilityValue()
    }
}

// Disposable, in-memory application and person-input driver for the native
// journey. This is never included in the product helper or its package.
@MainActor
final class Fixture: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    var draft = NSTextField(string: "Initial draft")
    var count = 0
    var otherCount = 0
    let dragSurface = DragSurface(frame: NSRect(x: 20, y: 5, width: 360, height: 25))
    let refreshLabel = RefreshLabel(labelWithString: "Ready after refresh")
    let counter = NSTextField(labelWithString: "Count: 0")
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Window IDs sort by creation: require choosing the nondefault window.
        let second = makeWindow("Other window", x: 600)
        let first = makeWindow("Workspace window", x: 80)
        let increment = NSButton(title: "Increment", target: self, action: #selector(increment))
        draft.setAccessibilityLabel("Draft text")
        let secret = NSSecureTextField(string: "private-fixture-value")
        secret.setAccessibilityLabel("Password")
        let stack = NSStackView(views: [NSTextField(labelWithString: "Computer Use Fixture"), draft, increment, counter, secret, refreshLabel])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
        stack.frame = NSRect(x: 24, y: 35, width: 340, height: 250)
        first.contentView?.addSubview(stack)
        dragSurface.setAccessibilityElement(true)
        dragSurface.setAccessibilityRole(.group)
        dragSurface.setAccessibilityLabel("Drag surface")
        first.contentView?.addSubview(dragSurface)
        let other = NSButton(title: "Other increment", target: self, action: #selector(incrementOther))
        other.frame = NSRect(x: 20, y: 100, width: 200, height: 40)
        second.contentView?.addSubview(other)
        windows = [first, second]
        first.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task.detached {
            while let line = readLine(), let data = line.data(using: .utf8) {
                guard let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                await self.handle(request)
            }
            await MainActor.run { NSApp.terminate(nil) }
        }
    }
    func makeWindow(_ title: String, x: CGFloat) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: x, y: 250, width: 420, height: 330), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title; window.isReleasedWhenClosed = false
        window.orderFront(nil)
        return window
    }
    @objc func increment() { count += 1; counter.stringValue = "Count: \(count)" }
    @objc func incrementOther() { otherCount += 1 }
    func handle(_ request: [String: Any]) {
        let method = request["method"] as? String ?? ""
        var result: [String: Any] = [:]
        switch method {
        case "refresh_changes":
            refreshLabel.reads = 0
            refreshLabel.remainingChanges = (request["params"] as? [String: Any])?["continuous"] as? Bool == true ? -1 : 2
            result = ["ok": true]
        case "refresh_stable": refreshLabel.remainingChanges = 0; refreshLabel.stringValue = "Ready after refresh"; result = ["ok": true]
        case "refresh_state": result = ["reads": refreshLabel.reads, "text": refreshLabel.stringValue]
        case "state": result = ["count": count, "otherCount": otherCount, "draft": draft.stringValue]
        case "minimized": result = ["minimized": windows[0].isMiniaturized]
        case "minimize": windows[0].miniaturize(nil); result = ["ok": true]
        case "restore": windows[0].deminiaturize(nil); result = ["ok": true]
        case "prepare_drag": windows[0].makeFirstResponder(nil); result = ["ok": true]
        case "drag_state": result = ["downs": dragSurface.downs, "moves": dragSurface.moves, "ups": dragSurface.ups]
        case "foreground_window": result = ["title": NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? (NSApp.keyWindow?.title ?? "") : ""]
        case "human_edit":
            windows[0].makeKeyAndOrderFront(nil)
            Task { @MainActor in
                let frame = self.windows[0].frame
                let point = CGPoint(x: frame.minX + 100, y: (NSScreen.screens.first?.frame.maxY ?? 0) - frame.maxY + 16)
                var hit: AXUIElement?
                var owner: pid_t = 0
                var ownsPoint = false
                for _ in 0..<20 {
                    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
                       let hit, AXUIElementGetPid(hit, &owner) == .success, owner == ProcessInfo.processInfo.processIdentifier {
                        ownsPoint = true; break
                    }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
                guard ownsPoint else { self.respond(request, result: ["ok": false, "stage": "fixture_window_covered"]); return }
                for type in [CGEventType.leftMouseDown, .leftMouseUp] {
                    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
                }
                for _ in 0..<20 {
                    if NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier { break }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
                // Only post person-input events while our disposable window owns focus.
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
                      NSApp.keyWindow == self.windows[0] else {
                    self.respond(request, result: ["ok": false, "stage": "focus", "front": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, "pid": ProcessInfo.processInfo.processIdentifier, "key": NSApp.keyWindow?.title ?? ""]); return
                }
                self.windows[0].makeFirstResponder(self.draft)
                if let editor = self.draft.currentEditor() { editor.selectAll(nil) }
                let units = Array("Edited by person".utf16)
                for down in [true, false] {
                    if let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) {
                        units.withUnsafeBufferPointer { buffer in
                            if let base = buffer.baseAddress { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base) }
                        }
                        event.post(tap: .cghidEventTap)
                    }
                }
                self.respond(request, result: ["ok": true])
            }
            return
        case "permissions": result = ["accessibility": AXIsProcessTrusted()]
        case "resize":
            windows[0].setContentSize(NSSize(width: 440, height: 350)); result = ["ok": true]
        case "front": windows[0].makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); result = ["ok": true]
        case "press_helper_button", "select_helper_window", "helper_panel":
            Task.detached {
                var result: [String: Any] = [:]
                let buttons: Set<String> = ["Allow this session", "Cancel", "Take over", "Continue", "Stop", "Hide panel", "Show Computer Use task"]
                if let params = request["params"] as? [String: Any], let pid = params["pid"] as? Int32,
                   let name = params["name"] as? String,
                   (method == "helper_panel" || (method == "select_helper_window" ? name == "Workspace window" : buttons.contains(name))),
                   let expected = params["executable"] as? String,
                   let process = NSRunningApplication(processIdentifier: pid),
                   process.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: expected).resolvingSymlinksInPath().path {
                    if method == "helper_panel" {
                        let task = self.findControl(pid: pid, title: nil, role: kAXWindowRole)
                        let button = self.findControl(pid: pid, title: "Continue", role: kAXButtonRole)
                        var enabled: CFTypeRef?
                        if let button { AXUIElementCopyAttributeValue(button, kAXEnabledAttribute as CFString, &enabled) }
                        result = ["text": task.map(self.accessibleText) ?? "", "continue_enabled": enabled as? Bool ?? false,
                                  "restore_available": self.findControl(pid: pid, title: "Show Computer Use task", role: kAXMenuBarItemRole) != nil]
                    } else {
                        result = method == "select_helper_window" ? self.selectWindow(pid: pid, title: name) : ["ok": self.pressButton(pid: pid, title: name)]
                    }
                } else { result = ["ok": false] }
                await self.respond(request, result: result)
            }
            return
        default: result = ["error": "Unknown fixture operation"]
        }
        respond(request, result: result)
    }
    func respond(_ request: [String: Any], result: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: ["id": request["id"] ?? NSNull(), "result": result], options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
    }
    nonisolated func accessibleText(_ root: AXUIElement) -> String {
        var visited = 0
        func read(_ element: AXUIElement, depth: Int) -> [String] {
            visited += 1
            guard depth < 18, visited < 800 else { return [] }
            var result: [String] = []
            for attribute in [kAXTitleAttribute, kAXValueAttribute] {
                var value: CFTypeRef?
                AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
                if let text = value as? String { result.append(text) }
            }
            var children: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
            for child in children as? [AXUIElement] ?? [] { result += read(child, depth: depth + 1) }
            return result
        }
        return read(root, depth: 0).joined(separator: "\n")
    }
    nonisolated func findControl(pid: pid_t, title: String?, role expectedRole: String) -> AXUIElement? {
        let root = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(root, 0.2)
        var visited = 0
        func find(_ element: AXUIElement, depth: Int) -> AXUIElement? {
            visited += 1
            guard depth < 18, visited < 800 else { return nil }
            var value: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &value)
            var role: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
            if (title == nil || value as? String == title) && role as? String == expectedRole { return element }
            var children: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
            for child in children as? [AXUIElement] ?? [] {
                if let result = find(child, depth: depth + 1) { return result }
            }
            return nil
        }
        return find(root, depth: 0)
    }
    nonisolated func selectWindow(pid: pid_t, title: String) -> [String: Any] {
        guard let picker = findControl(pid: pid, title: nil, role: kAXPopUpButtonRole) else { return ["ok": false] }
        var previous: CFTypeRef?
        AXUIElementCopyAttributeValue(picker, kAXValueAttribute as CFString, &previous)
        guard AXUIElementPerformAction(picker, kAXPressAction as CFString) == .success,
              let item = findControl(pid: pid, title: title, role: kAXMenuItemRole),
              AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { return ["ok": false] }
        var selected: CFTypeRef?
        for _ in 0..<50 {
            AXUIElementCopyAttributeValue(picker, kAXValueAttribute as CFString, &selected)
            if selected as? String == title { break }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return ["ok": true, "previous": previous as? String ?? "", "selected": selected as? String ?? ""]
    }
    nonisolated func pressButton(pid: pid_t, title: String) -> Bool {
        guard let button = findControl(pid: pid, title: title, role: title == "Show Computer Use task" ? kAXMenuBarItemRole : kAXButtonRole) else { return false }
        return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
    }
}

@main
struct FixtureMain {
    @MainActor static func main() {
        setbuf(stdout, nil)
        NSApplication.shared.setActivationPolicy(.regular)
        let fixture = Fixture()
        NSApplication.shared.delegate = fixture
        withExtendedLifetime(fixture) { NSApplication.shared.run() }
    }
}
