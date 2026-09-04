import AppKit
import ApplicationServices

// Disposable, in-memory application and person-input driver for the native
// journey. This is never included in the product helper or its package.
@MainActor
final class Fixture: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    var draft = NSTextField(string: "Initial draft")
    var count = 0
    var otherCount = 0
    let counter = NSTextField(labelWithString: "Count: 0")
    func applicationDidFinishLaunching(_ notification: Notification) {
        let first = makeWindow("Workspace window", x: 80)
        let increment = NSButton(title: "Increment", target: self, action: #selector(increment))
        draft.setAccessibilityLabel("Draft text")
        let secret = NSSecureTextField(string: "private-fixture-value")
        secret.setAccessibilityLabel("Password")
        let stack = NSStackView(views: [NSTextField(labelWithString: "Computer Use Fixture"), draft, increment, counter, secret])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
        stack.frame = NSRect(x: 24, y: 35, width: 340, height: 250)
        first.contentView?.addSubview(stack)
        let second = makeWindow("Other window", x: 600)
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
        let window = NSWindow(contentRect: NSRect(x: x, y: 250, width: 420, height: 330), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
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
        case "state": result = ["count": count, "otherCount": otherCount, "draft": draft.stringValue]
        case "permissions": result = ["accessibility": AXIsProcessTrusted()]
        case "resize":
            windows[0].setContentSize(NSSize(width: 440, height: 350)); result = ["ok": true]
        case "front": windows[0].makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); result = ["ok": true]
        case "press_helper_button":
            let buttons: Set<String> = ["Allow this session", "Cancel", "Pause", "Resume", "Stop"]
            if let params = request["params"] as? [String: Any], let pid = params["pid"] as? Int32,
               let name = params["name"] as? String, buttons.contains(name),
               let expected = params["executable"] as? String,
               let process = NSRunningApplication(processIdentifier: pid),
               process.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: expected).resolvingSymlinksInPath().path {
                result = ["ok": pressButton(pid: pid, title: name)]
            } else { result = ["ok": false] }
        default: result = ["error": "Unknown fixture operation"]
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["id": request["id"] ?? NSNull(), "result": result], options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
    }
    func pressButton(pid: pid_t, title: String) -> Bool {
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
            if value as? String == title && role as? String == kAXButtonRole { return element }
            var children: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
            for child in children as? [AXUIElement] ?? [] {
                if let result = find(child, depth: depth + 1) { return result }
            }
            return nil
        }
        guard let button = find(root, depth: 0) else { return false }
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
