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
final class SessionControls: NSObject {
    /// The OpenWork desktop hosts approval and Continue over openwork/ui.
    /// Otherwise (standalone `mcp`) the helper shows native consent and controls.
    static var embedded = false
    static weak var active: SessionControls?
    private var hostID = UUID().uuidString
    private var hostState: [String: Any] = [:]
    private var frameSequence = 0
    private var inputSequence = 0
    private var lastFrameAt: TimeInterval = -.infinity
    private var canContinue = false
    private var approval: ((WindowTarget?) -> Void)?
    private var approvalWindows: [WindowTarget] = []
    private var menuToggle: NSMenuItem?

    private func publish(_ values: [String: Any]) {
        guard Self.embedded else { return }
        hostState.merge(values) { _, new in new }
        hostState["id"] = hostID
        hostState["kind"] = "state"
        let fields: Set<String> = ["kind", "id", "phase", "appName", "appID", "pid", "windowTitle", "task", "mode", "windows", "status", "canContinue"]
        hostState = hostState.filter { fields.contains($0.key) }
        if hostState["phase"] as? String != "approval" { hostState.removeValue(forKey: "windows") }
        MCPOutput.shared.send(["jsonrpc": "2.0", "method": "openwork/ui", "params": hostState])
    }
    func frame(_ data: Data, width: Int, height: Int, capturedAt: Int64) {
        guard Self.embedded, Self.active === self, hostState["phase"] as? String == "working",
              MCPOutput.shared.canSendFrame, ProcessInfo.processInfo.systemUptime - lastFrameAt >= 0.2 else { return }
        lastFrameAt = ProcessInfo.processInfo.systemUptime
        frameSequence += 1
        MCPOutput.shared.send(["jsonrpc": "2.0", "method": "openwork/ui", "params": [
            "kind": "frame", "id": hostID, "sequence": frameSequence, "capturedAt": capturedAt,
            "width": width, "height": height, "mimeType": "image/png", "data": data.base64EncodedString()
        ]], frame: true)
    }
    func inputFeedback(_ feedback: InputFeedback) {
        AgentCursor.shared.feedback(action: feedback.action, phase: feedback.phase, screenPoint: feedback.screenPoint, windowFrame: feedback.frame)
        guard Self.embedded, Self.active === self,
              ["working", "paused"].contains(hostState["phase"] as? String ?? "") else { return }
        inputSequence += 1
        var value = feedback.payload
        value["kind"] = "input"; value["id"] = hostID; value["sequence"] = inputSequence
        MCPOutput.shared.send(["jsonrpc": "2.0", "method": "openwork/ui", "params": value])
    }
    func hostDisconnected() {
        cancelConsent(); onStop?()
    }
    func hostAction(_ value: [String: Any]) {
        guard Self.embedded,
              value["id"] as? String == hostID, let action = value["action"] as? String else { return }
        switch action {
        case "approve":
            guard let id = try? Arguments(values: value).integer("windowId", min: 1, max: Int(UInt32.max)),
                  let target = approvalWindows.first(where: { Int($0.id) == id }), let approval else { return }
            self.approval = nil; approvalWindows = []; approval(target)
        case "deny": cancelConsent()
        case "resume":
            if isPaused && canContinue { onResume?() }
        case "takeover":
            onPause?("You have control. Click Continue when you are ready.")
        case "watch":
            guard let visible = try? Arguments(values: value).bool("visible", default: false) else { return }
            onWatch?(visible)
        case "stop": cancelConsent(); onStop?()
        // Embedded sessions show no native panel; "hide"/"show" are accepted and ignored.
        default: break
        }
    }
    func narrate(_ text: String?) { AgentCursor.shared.narrate(text) }
    func showAction(_ action: Action, records: [ElementRecord]) {
        switch action {
        case .press(let ref), .setValue(let ref, _):
            if let record = records.first(where: { $0.ref == ref }) { AgentCursor.shared.highlight(screenRect: record.frame) }
        default: break
        }
    }

    private func showMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "OpenWork computer use")
        item.button?.setAccessibilityTitle("OpenWork computer use controls")
        item.button?.toolTip = "OpenWork Computer Use · Take over or Stop"
        let menu = NSMenu(); menu.autoenablesItems = false
        let pause = NSMenuItem(title: "Take over", action: #selector(togglePause), keyEquivalent: "")
        pause.target = self; menu.addItem(pause); menuToggle = pause
        menu.addItem(.separator())
        let end = NSMenuItem(title: "Stop computer use and end access", action: #selector(stopSession), keyEquivalent: "")
        end.target = self; menu.addItem(end)
        item.menu = menu; statusItem = item
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
    var onUserInteraction: (() -> Void)?
    var onPause: ((String) -> Void)?
    var onResume: (() -> Void)?
    var onStop: (() -> Void)?
    var onTick: (() -> Void)?
    var onWatch: ((Bool) -> Void)?
    var isPaused = false

    func chooseWindow(app: AppIdentity, mode: AccessMode, windows: [WindowTarget], purpose: String) async throws -> WindowTarget {
        if Self.embedded {
            Self.active = self; hostID = UUID().uuidString; hostState = [:]; approvalWindows = windows
            frameSequence = 0; inputSequence = 0; lastFrameAt = -.infinity; canContinue = false
            let target: WindowTarget? = await withCheckedContinuation { continuation in
                approval = { continuation.resume(returning: $0) }
                publish(["phase": "approval", "appName": app.name, "appID": app.bundleID, "pid": Int(app.pid),
                    "windowTitle": "", "task": purpose, "mode": mode.rawValue, "status": "Waiting for window approval.", "canContinue": false,
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
        host.title = "Computer Use · App access"
        host.isReleasedWhenClosed = false
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
        if let approval { self.approval = nil; approvalWindows = []; approval(nil); publish(["phase": "closed", "status": "Access declined.", "canContinue": false]) }
        if let host = consentWindow, let sheet = host.attachedSheet { host.endSheet(sheet, returnCode: .cancel) }
    }

    func show(app: AppIdentity, target: WindowTarget, mode: AccessMode, purpose: String) {
        isPaused = false; canContinue = true
        let presence = AgentCursor.shared
        presence.onTakeOver = { [weak self] in
            guard let self, !self.isPaused else { return }
            self.onPause?("You have control. Click Continue when you are ready.")
        }
        // The person's own click on the badge: the same human-only Continue as the native controls.
        presence.onContinue = { [weak self] in
            guard let self, self.isPaused, self.canContinue else { return }
            self.onResume?()
        }
        presence.onStop = { [weak self] in self?.onStop?() }
        presence.begin(windowFrame: target.frame, windowID: target.id, appName: app.name)
        if Self.embedded {
            showMenu()
            publish(["phase": "working", "appName": app.name, "appID": app.bundleID, "pid": Int(app.pid),
                "windowTitle": target.title, "task": purpose, "mode": mode.rawValue, "status": "Starting...", "canContinue": true])
        } else {
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
        // Clicks, typing, scrolling and dragging on the approved app, and app switches,
        // still stop agent input. Scrolling or dragging over another app (such as reading
        // the conversation while the agent works) does not; a click there activates that
        // app, and the switch below pauses control.
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown,
            .keyDown, .scrollWheel, .leftMouseDragged, .rightMouseDragged]) { [weak self] event in
            guard let self else { return }
            // Our own postToPid events cannot be mistaken for a person taking over.
            if event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == Int64(ProcessInfo.processInfo.processIdentifier) { return }
            let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid
            let counts = event.type == .keyDown ? frontmost : mode == .control ? Self.pointerOnApp(app.pid, frontmost: frontmost) : frontmost
            if counts { self.onUserInteraction?() }
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
                    self?.onPause?("You switched apps. Continue will return to the approved window.")
                }
            }
        })
        stopObserver = DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.differentai.openwork.computer-use.stop"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onStop?() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.onTick?() }
        }
        // Keep expiry and screenshot age current while the menu-bar controls are open.
        if Self.embedded, let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    /// Whether the pointer is over one of the approved app's windows (or the menu bar
    /// while it is frontmost). Unknown geometry counts, so a missed read never hides a takeover.
    private static func pointerOnApp(_ pid: pid_t, frontmost: Bool) -> Bool {
        let mouse = NSEvent.mouseLocation
        let point = CGPoint(x: mouse.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - mouse.y)
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return true }
        let own = ProcessInfo.processInfo.processIdentifier
        let menuLevel = Int(CGWindowLevelForKey(.mainMenuWindow))
        // Front to back: the first window under the pointer receives the input.
        for window in windows {
            guard let bounds = (window[kCGWindowBounds as String] as? [String: Any]).flatMap({ CGRect(dictionaryRepresentation: $0 as CFDictionary) }),
                  bounds.contains(point) else { continue }
            let owner = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
            if owner == own { continue }
            if owner == pid { return true }
            if (window[kCGWindowLayer as String] as? NSNumber)?.intValue == menuLevel { return frontmost }
            return false
        }
        return false
    }

    func update(_ message: String, paused: Bool, canContinue: Bool = true) {
        publish(["phase": paused ? "paused" : "working", "status": message, "canContinue": canContinue])
        self.canContinue = canContinue
        AgentCursor.shared.setPaused(paused, canContinue: canContinue)
        isPaused = paused; status?.stringValue = message; toggle?.title = paused ? "Continue" : "Take over"
        toggle?.isEnabled = !paused || canContinue
        menuToggle?.title = paused ? "Continue in approved window" : "Take over"
        menuToggle?.isEnabled = !paused || canContinue
    }
    func updateExpiry(seconds: Int) {
        expiry?.stringValue = String(format: "Access ends in %d:%02d", seconds / 60, seconds % 60)
    }
    func close() {
        cancelConsent()
        AgentCursor.shared.end()
        if Self.active === self && hostState["phase"] as? String != "closed" {
            publish(["phase": "closed", "status": "Access ended.", "canContinue": false])
        }
        Self.active = nil; canContinue = false; menuToggle = nil
        status = nil; toggle = nil; expiry = nil; isPaused = false
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }; statusItem = nil
        panel?.close(); panel = nil; timer?.invalidate(); timer = nil
        if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll()
        if let stopObserver { DistributedNotificationCenter.default().removeObserver(stopObserver) }; stopObserver = nil
    }
    @objc private func hidePanel() { panel?.orderOut(nil) }
    @objc private func showPanel() { panel?.orderFrontRegardless() }
    @objc private func togglePause() {
        if isPaused { if canContinue { onResume?() } }
        else { onPause?("You have control. Click Continue when you are ready.") }
    }
    @objc private func stopSession() { onStop?() }
}
