import AppKit
import ApplicationServices
import Darwin

enum LeaseFiles {
    static func directory() throws -> URL {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("OpenWork/ComputerUse", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return directory
    }
    /// An exclusive lock on `path`, or nil when another holder has it. The kernel releases it on exit.
    static func lock(_ path: String) throws -> Int32? {
        for _ in 0..<3 {
            let fd = Darwin.open(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw UseError("control_unavailable", "Could not reserve computer control.", next: "human_takeover") }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(fd); return nil }
            // A releasing holder unlinks its file: only a lock on the file still at `path` counts.
            var held = stat(), named = stat()
            if fstat(fd, &held) == 0, lstat(path, &named) == 0, held.st_dev == named.st_dev, held.st_ino == named.st_ino { return fd }
            flock(fd, LOCK_UN); Darwin.close(fd)
        }
        return nil
    }
}

// One agent per window, held for the session including while paused. Other
// windows stay free for other chats; FocusLease keeps their input apart.
final class ControlLease {
    private var fd: Int32 = -1
    private let path: String
    init(pid: pid_t, window: CGWindowID, directory: URL? = nil) throws {
        path = try (directory ?? LeaseFiles.directory()).appendingPathComponent("window-\(pid)-\(window).lock").path
        guard let fd = try LeaseFiles.lock(path) else {
            throw UseError("window_busy", "Another agent is working in this window. Choose another window, or wait for that chat to finish.", next: "open_session")
        }
        self.fd = fd
    }
    deinit {
        guard fd >= 0 else { return }
        unlink(path); flock(fd, LOCK_UN); Darwin.close(fd)
    }
}

// The Mac has one keyboard focus and pointer. Held only while a control
// session brings its window forward, reads it and sends input.
final class FocusLease {
    private var fd: Int32
    /// Removed on release; the shared focus file stays.
    private let path: String?
    private init(fd: Int32, path: String? = nil) { self.fd = fd; self.path = path }
    @MainActor static func acquire(directory: URL? = nil, timeout: TimeInterval = 15, check: () throws -> Void) async throws -> FocusLease {
        let path = try (directory ?? LeaseFiles.directory()).appendingPathComponent("focus.lock").path
        return FocusLease(fd: try await wait(path, timeout: timeout, check: check,
            busy: "Another agent kept the keyboard and pointer too long. Nothing was dispatched. Observe again."))
    }
    /// An app sends its keys to its one key window. Held from the moment a control step
    /// may change which window that is, by bringing its window forward or selecting it in
    /// the background, until its input is sent, so agents in different windows of one app
    /// never type into each other's window. Taken after the focus lease, never before.
    @MainActor static func acquire(app pid: pid_t, directory: URL? = nil, timeout: TimeInterval = 15, check: () throws -> Void) async throws -> FocusLease {
        let path = try (directory ?? LeaseFiles.directory()).appendingPathComponent("app-\(pid).lock").path
        return FocusLease(fd: try await wait(path, timeout: timeout, check: check,
            busy: "Another agent kept this app's keyboard focus too long. Nothing was dispatched. Observe again."), path: path)
    }
    @MainActor private static func wait(_ path: String, timeout: TimeInterval, check: () throws -> Void, busy: String) async throws -> Int32 {
        let started = ProcessInfo.processInfo.systemUptime
        while true {
            try Task.checkCancellation(); try check()
            if let fd = try LeaseFiles.lock(path) { return fd }
            guard ProcessInfo.processInfo.systemUptime - started < timeout else {
                throw UseError("focus_busy", busy, next: "observe")
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
    /// The lease only when no other agent holds it right now; never waits.
    static func attempt(directory: URL? = nil) -> FocusLease? {
        guard let path = try? (directory ?? LeaseFiles.directory()).appendingPathComponent("focus.lock").path,
              let fd = try? LeaseFiles.lock(path) else { return nil }
        return FocusLease(fd: fd)
    }
    func release() {
        guard fd >= 0 else { return }
        if let path { unlink(path) }
        flock(fd, LOCK_UN); Darwin.close(fd); fd = -1
    }
    deinit { release() }
}

@MainActor
final class SessionControls: NSObject {
    /// The OpenWork desktop hosts Take over, Continue and Stop over openwork/ui.
    /// Standalone `mcp` exposes the same controls in a native panel.
    static var embedded = false
    static weak var active: SessionControls?
    private var hostID = UUID().uuidString
    private var hostState: [String: Any] = [:]
    private var frameSequence = 0
    private var inputSequence = 0
    private var lastFrameAt: TimeInterval = -.infinity
    private var canContinue = false
    private var menuToggle: NSMenuItem?

    private func publish(_ values: [String: Any]) {
        guard Self.embedded else { return }
        hostState.merge(values) { _, new in new }
        hostState["id"] = hostID
        hostState["kind"] = "state"
        let fields: Set<String> = ["kind", "id", "phase", "appName", "appID", "pid", "windowTitle", "task", "mode", "status", "canContinue", "cause"]
        hostState = hostState.filter { fields.contains($0.key) }
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
        onStop?()
    }
    func hostAction(_ value: [String: Any]) {
        guard Self.embedded,
              value["id"] as? String == hostID, let action = value["action"] as? String else { return }
        switch action {
        case "resume":
            if isPaused && canContinue { onResume?() }
        case "takeover":
            onPause?("You have control. Click Continue when you are ready.")
        case "watch":
            guard let visible = try? Arguments(values: value).bool("visible", default: false) else { return }
            onWatch?(visible)
        case "stop": onStop?()
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

    func showMenu(titleFrame: CGRect?, path: [String], shortcut: String?) {
        AgentCursor.shared.showMenu(titleFrame: titleFrame, path: path, shortcut: shortcut)
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
        let end = NSMenuItem(title: "Stop computer use", action: #selector(stopSession), keyEquivalent: "")
        end.target = self; menu.addItem(end)
        item.menu = menu; statusItem = item
    }

    private var panel: NSPanel?
    private var status: NSTextField?
    private var toggle: NSButton?
    private var expiry: NSTextField?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var stopObserver: NSObjectProtocol?
    private var timer: Timer?
    private var statusItem: NSStatusItem?
    var isVisible: Bool { panel?.isVisible == true }
    private var desktopAvailable = true
    var onAvailability: ((Bool) -> Void)?
    var onPause: ((String) -> Void)?
    var onResume: (() -> Void)?
    var onStop: (() -> Void)?
    var onTick: (() -> Void)?
    var onWatch: ((Bool) -> Void)?
    var isPaused = false

    func show(app: AppIdentity, target: WindowTarget, mode: AccessMode, purpose: String, background: Bool = false) {
        Self.active = self; hostID = UUID().uuidString; hostState = [:]
        frameSequence = 0; inputSequence = 0; lastFrameAt = -.infinity
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
        presence.begin(windowFrame: target.frame, windowID: target.id, appName: app.name, layered: background)
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
        let expiry = NSTextField(labelWithString: "Computer use enabled")
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
        // The person's own clicks, typing and app switches never pause the agent: it brings the
        // selected window back before it acts. Only Take over or Stop hands control back.
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.desktopAvailable = false; self?.onAvailability?(false) }
            })
        }
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.desktopAvailable = true; self?.onAvailability?(true) }
            })
        }
        stopObserver = DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.differentai.openwork.computer-use.stop"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onStop?() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.onTick?() }
        }
        // Keep expiry and screenshot age current while the menu-bar controls are open.
        if Self.embedded, let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    func update(_ message: String, paused: Bool, canContinue: Bool = true) {
        publish(["phase": paused ? "paused" : "working", "status": message, "canContinue": canContinue])
        self.canContinue = canContinue
        AgentCursor.shared.setPaused(paused, canContinue: canContinue)
        isPaused = paused; status?.stringValue = message; toggle?.title = paused ? "Continue" : "Take over"
        toggle?.isEnabled = !paused || canContinue
        menuToggle?.title = paused ? "Continue in selected window" : "Take over"
        menuToggle?.isEnabled = !paused || canContinue
    }
    func updateExpiry(seconds: Int) {
        expiry?.stringValue = "Computer use enabled"
    }
    func close(stoppedByPerson: Bool = false) {
        AgentCursor.shared.end()
        if Self.active === self && hostState["phase"] as? String != "closed" {
            publish(["phase": "closed", "status": stoppedByPerson ? "Stopped by you." : "Session ended.", "canContinue": false, "cause": stoppedByPerson ? "human_stop" : "session_end"])
        }
        Self.active = nil; canContinue = false; menuToggle = nil
        status = nil; toggle = nil; expiry = nil; isPaused = false
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }; statusItem = nil
        panel?.close(); panel = nil; timer?.invalidate(); timer = nil
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
