import AppKit
import ApplicationServices
import Darwin

// Held for the session, including while paused. The kernel releases it on exit.
final class ControlLease {
    private var fd: Int32 = -1
    init() throws {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("OpenWork/ComputerUse", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        fd = Darwin.open(directory.appendingPathComponent("control.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw UseError("control_unavailable", "Could not reserve computer control.", next: "human_takeover") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(fd); fd = -1
            throw UseError("computer_busy", "Another Computer Use session has control. Stop it before starting a new one.", next: "human_takeover")
        }
    }
    deinit { if fd >= 0 { flock(fd, LOCK_UN); Darwin.close(fd) } }
}

@MainActor
private final class AgentPreview: NSImageView {
    var actionPoint: CGPoint? { didSet { needsDisplay = true } }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let image, let point = actionPoint, image.size.width > 0, image.size.height > 0 else { return }
        let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
        let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        let position = NSPoint(x: (bounds.width - size.width) / 2 + point.x * size.width,
                               y: (bounds.height - size.height) / 2 + (1 - point.y) * size.height)
        NSColor.systemBlue.withAlphaComponent(0.5).setFill()
        NSBezierPath(ovalIn: NSRect(x: position.x - 9, y: position.y - 9, width: 18, height: 18)).fill()
        NSCursor.arrow.image.draw(in: NSRect(x: position.x, y: position.y - 18, width: 14, height: 20))
    }
}

@MainActor
final class SessionControls: NSObject {
    static var hosted = false
    static weak var active: SessionControls?
    private var hostID = UUID().uuidString
    private var hostState: [String: Any] = [:]
    private var approval: ((WindowTarget?) -> Void)?
    private var approvalWindows: [WindowTarget] = []
    private var previewView: AgentPreview?

    private func publish(_ values: [String: Any]) {
        guard Self.hosted else { return }
        hostState.merge(values) { _, new in new }
        hostState["id"] = hostID
        guard let data = try? JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "method": "openwork/ui", "params": hostState]) else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }
    func hostAction(_ value: [String: Any]) {
        guard value["id"] as? String == hostID, let action = value["action"] as? String else { return }
        switch action {
        case "approve":
            guard let id = value["windowId"] as? Int, let target = approvalWindows.first(where: { Int($0.id) == id }), let approval else { return }
            self.approval = nil; approvalWindows = []; approval(target)
        case "deny": cancelConsent()
        case "resume": onResume?()
        case "stop": cancelConsent(); onStop?()
        case "hide": hidePanel()
        case "show": showPanel()
        default: break
        }
    }
    func preview(_ data: Data) {
        guard Self.hosted else { return }
        previewView?.image = NSImage(data: data)
        previewView?.actionPoint = nil
        previewView?.setAccessibilityLabel("Latest approved window observation")
    }
    func showAction(_ action: Action, observation: ObservationLease, records: [ElementRecord]) {
        guard Self.hosted else { return }
        let point: CGPoint?
        switch action {
        case .click(let location, _), .scroll(let location, _, _): point = location
        case .drag(let path): point = path.last
        case .press(let ref), .setValue(let ref, _):
            point = records.first(where: { $0.ref == ref }).map {
                CGPoint(x: ($0.frame.midX - observation.frame.minX) / observation.frame.width * CGFloat(observation.imageWidth),
                        y: ($0.frame.midY - observation.frame.minY) / observation.frame.height * CGFloat(observation.imageHeight))
            }
        default: point = nil
        }
        previewView?.actionPoint = point.map { CGPoint(x: $0.x / CGFloat(observation.imageWidth), y: $0.y / CGFloat(observation.imageHeight)) }
        panel?.title = "Latest agent view · \(action.name)"
    }
    private func showHosted(app: AppIdentity, target: WindowTarget, mode: AccessMode, purpose: String) {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 190), styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Latest agent view · \(app.name)"
        panel.level = .floating; panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        let image = AgentPreview(frame: NSRect(x: 0, y: 0, width: 300, height: 190))
        image.imageScaling = .scaleProportionallyUpOrDown
        image.autoresizingMask = [.width, .height]; image.image = app.app.icon
        panel.contentView?.addSubview(image); previewView = image; self.panel = panel
        let hide = NSButton(title: "Hide", target: self, action: #selector(hidePanel))
        hide.frame = NSRect(x: 182, y: 6, width: 50, height: 24)
        let stop = NSButton(title: "Stop", target: self, action: #selector(stopSession))
        stop.frame = NSRect(x: 238, y: 6, width: 54, height: 24)
        panel.contentView?.addSubview(hide); panel.contentView?.addSubview(stop)
        if let screen = NSScreen.main { panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.maxX - 316, y: screen.visibleFrame.maxY - 16)) }
        panel.orderFrontRegardless()
        publish(["phase": "working", "appName": app.name, "windowTitle": target.title, "task": purpose, "mode": mode.rawValue, "status": "Starting…", "canContinue": true, "previewVisible": true])
    }

    private var panel: NSPanel?
    private var status: NSTextField?
    private var toggle: NSButton?
    private var expiry: NSTextField?
    private var monitor: Any?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var stopObserver: NSObjectProtocol?
    private var timer: Timer?
    private var consentWindow: NSWindow?
    private var statusItem: NSStatusItem?
    var isVisible: Bool { panel?.isVisible == true }
    var onAppSwitch: (() -> Void)?
    var onUserInteraction: (() -> Void)?
    var onPause: ((String) -> Void)?
    var onResume: (() -> Void)?
    var onStop: (() -> Void)?
    var onTick: (() -> Void)?
    var isPaused = false

    func chooseWindow(app: AppIdentity, mode: AccessMode, windows: [WindowTarget], purpose: String) async throws -> WindowTarget {
        if Self.hosted {
            Self.active = self; hostID = UUID().uuidString; hostState = [:]; approvalWindows = windows
            let target: WindowTarget? = await withCheckedContinuation { continuation in
                approval = { continuation.resume(returning: $0) }
                publish(["phase": "approval", "appName": app.name, "task": purpose, "mode": mode.rawValue,
                    "windows": windows.map { ["id": Int($0.id), "title": $0.title] }])
            }
            guard let target else { throw UseError("access_denied", "App access was declined. Wait for the person to ask again.", next: "human_takeover") }
            return target
        }
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Allow OpenWork to use \(app.name)?"
        alert.informativeText = "\(mode.explanation)\n\nChoose the window below. This approval lasts for this session, up to 15 minutes. App content may be sent to your selected model provider.\n\nRequested task: \(purpose)\n\nApp: \(app.bundleID)"
        alert.icon = app.app.icon
        alert.addButton(withTitle: mode == .control ? "Allow and start" : "Allow this session")
        alert.addButton(withTitle: "Cancel")
        // Allow is deliberately not the Return default: a previous app's typing must not consent.
        alert.buttons[0].keyEquivalent = ""
        alert.buttons[1].keyEquivalent = "\u{1b}"
        let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 390, height: 28))
        picker.addItems(withTitles: windows.map { String($0.title.prefix(120)) })
        picker.setAccessibilityLabel("Window to allow")
        alert.accessoryView = picker
        let host = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 80), styleMask: [.titled], backing: .buffered, defer: false)
        host.title = "Computer Use · App access"; host.isReleasedWhenClosed = false
        host.center(); host.makeKeyAndOrderFront(nil); consentWindow = host
        NSApplication.shared.activate(ignoringOtherApps: true)
        let response = await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: host) { continuation.resume(returning: $0) }
        }
        host.close(); consentWindow = nil
        guard response == .alertFirstButtonReturn else { throw UseError("access_denied", "The person declined app access. Do not request it again unless they ask.", next: "human_takeover") }
        return windows[picker.indexOfSelectedItem]
    }
    func cancelConsent() {
        if let approval { self.approval = nil; approvalWindows = []; approval(nil); publish(["phase": "closed"]) }
        if let host = consentWindow, let sheet = host.attachedSheet { host.endSheet(sheet, returnCode: .cancel) }
    }

    func show(app: AppIdentity, target: WindowTarget, mode: AccessMode, purpose: String) {
        if Self.hosted { showHosted(app: app, target: target, mode: mode, purpose: purpose) } else {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 230),
            styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "OpenWork Computer Use"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        let title = NSTextField(labelWithString: "\(app.name) · \(mode.title)")
        title.font = .boldSystemFont(ofSize: 14)
        let window = NSTextField(labelWithString: String(target.title.prefix(80)))
        window.lineBreakMode = .byTruncatingTail
        let task = NSTextField(wrappingLabelWithString: String(purpose.prefix(500)))
        task.maximumNumberOfLines = 3
        task.lineBreakMode = .byTruncatingTail
        task.setAccessibilityLabel("Current task")
        let expiry = NSTextField(labelWithString: "Access ends in 15:00")
        expiry.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        expiry.textColor = .secondaryLabelColor
        let status = NSTextField(wrappingLabelWithString: "OpenWork is working. You can take over at any time.")
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        let toggle = NSButton(title: "Take over", target: self, action: #selector(togglePause))
        let stop = NSButton(title: "Stop", target: self, action: #selector(stopSession))
        stop.bezelColor = .systemRed
        let hide = NSButton(title: "Hide panel", target: self, action: #selector(hidePanel))
        let buttons = NSStackView(views: [toggle, stop, hide])
        buttons.spacing = 8
        let stack = NSStackView(views: [title, window, task, status, expiry, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 9
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView?.addSubview(stack)
        if let content = panel.contentView {
            NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
                stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
                stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 14)])
        }
        if let screen = NSScreen.main {
            panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.maxX - 400, y: screen.visibleFrame.maxY - 20))
        }
        self.panel = panel; self.status = status; self.toggle = toggle; self.expiry = expiry
        panel.orderFrontRegardless()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "OW"
        item.button?.setAccessibilityTitle("Show Computer Use task")
        item.button?.toolTip = "Show Computer Use controls"
        item.button?.target = self
        item.button?.action = #selector(showPanel)
        statusItem = item
        }
        // Passive pointer motion (including activation-generated motion) is not takeover.
        // Clicks, typing, scrolling, dragging and app switches still stop agent input.
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown,
            .keyDown, .scrollWheel, .leftMouseDragged, .rightMouseDragged]) { [weak self] event in
            guard let self else { return }
            // Our own postToPid events cannot be mistaken for a person taking over.
            if event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == Int64(ProcessInfo.processInfo.processIdentifier) { return }
            if mode == .control || NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid {
                self.onUserInteraction?()
            }
        }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.onPause?("Paused while the desktop is unavailable. Click Continue when you are ready.") }
            })
        }
        workspaceObservers.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            MainActor.assumeIsolated {
                if mode == .control, let activated = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                   activated.processIdentifier != app.pid, NSWorkspace.shared.frontmostApplication?.processIdentifier != app.pid {
                    if Self.hosted { self?.onAppSwitch?() }
                    else { self?.onPause?("You switched apps. Continue will return to the approved window.") }
                }
            }
        })
        stopObserver = DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.differentai.openwork.computer-use.stop"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onStop?() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.onTick?() }
        }
    }
    func update(_ message: String, paused: Bool, canContinue: Bool = true, recoverable: Bool = false) {
        publish(["phase": paused ? "paused" : "working", "status": message, "canContinue": canContinue, "recoverable": recoverable])
        isPaused = paused; status?.stringValue = message; toggle?.title = paused ? "Continue" : "Take over"
        toggle?.isEnabled = !paused || canContinue
    }
    func updateExpiry(seconds: Int) {
        publish(["remainingSeconds": seconds])
        expiry?.stringValue = String(format: "Access ends in %d:%02d", seconds / 60, seconds % 60)
    }
    func close() {
        cancelConsent(); publish(["phase": "closed"]); previewView = nil; Self.active = nil
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }; statusItem = nil
        panel?.close(); panel = nil; timer?.invalidate(); timer = nil
        if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll()
        if let stopObserver { DistributedNotificationCenter.default().removeObserver(stopObserver) }; stopObserver = nil
    }
    @objc private func hidePanel() { panel?.orderOut(nil); publish(["previewVisible": false]) }
    @objc private func showPanel() { panel?.orderFrontRegardless(); publish(["previewVisible": true]) }
    @objc private func togglePause() { if isPaused { onResume?() } else { onPause?("You have control. Click Continue when you are ready.") } }
    @objc private func stopSession() { onStop?() }
}

@MainActor
final class PermissionSetup: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var accessibility: NSTextField?
    private var capture: NSTextField?
    private var timer: Timer?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 370), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Computer Use"; window.isReleasedWhenClosed = false
        let title = NSTextField(labelWithString: "Choose what OpenWork can use")
        title.font = .boldSystemFont(ofSize: 23)
        let description = NSTextField(wrappingLabelWithString: "macOS permissions enable the helper. You approve an app, a window and a control mode separately for each session. Your input interrupts control; Stop in the preview ends access.")
        let accessibility = NSTextField(labelWithString: "")
        let capture = NSTextField(labelWithString: "")
        let axButton = NSButton(title: "Open Accessibility settings", target: self, action: #selector(openAccessibility))
        let captureButton = NSButton(title: "Open Screen Recording settings", target: self, action: #selector(openCapture))
        let stop = NSButton(title: "Stop all Computer Use sessions", target: self, action: #selector(stopAll))
        let footer = NSTextField(wrappingLabelWithString: "After allowing access, return to Library → Computer Use in OpenWork to finish setup. If macOS asks you to restart, quit and reopen OpenWork. Windows and Linux desktop control are not available in this version.")
        footer.font = .systemFont(ofSize: 12); footer.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [title, description, accessibility, axButton, capture, captureButton, stop, footer])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(stack)
        if let content = window.contentView {
            NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
                stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
                stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24)])
        }
        self.window = window; self.accessibility = accessibility; self.capture = capture
        refresh(); window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.refresh() } }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    private func refresh() {
        accessibility?.stringValue = "Accessibility · \(AXIsProcessTrusted() ? "Allowed" : "Needed to read and use app controls")"
        capture?.stringValue = "Screen Recording · \(CGPreflightScreenCaptureAccess() ? "Allowed" : "Needed to see the selected window")"
    }
    @objc private func openAccessibility() {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
    @objc private func openCapture() {
        CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }
    @objc private func stopAll() {
        DistributedNotificationCenter.default().postNotificationName(Notification.Name("com.differentai.openwork.computer-use.stop"), object: nil, userInfo: nil, deliverImmediately: true)
    }
}
