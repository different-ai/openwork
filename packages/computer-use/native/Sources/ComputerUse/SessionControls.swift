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
    private var panel: NSPanel?
    private var status: NSTextField?
    private var toggle: NSButton?
    private var expiry: NSTextField?
    private var monitor: Any?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var stopObserver: NSObjectProtocol?
    private var timer: Timer?
    private var consentWindow: NSWindow?
    var onPause: ((String) -> Void)?
    var onResume: (() -> Void)?
    var onStop: (() -> Void)?
    var onTick: (() -> Void)?
    var isPaused = false

    func chooseWindow(app: AppIdentity, mode: AccessMode, windows: [WindowTarget], purpose: String) async throws -> WindowTarget {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Allow OpenWork to use \(app.name)?"
        alert.informativeText = "\(mode.explanation)\n\nChoose the window below. This approval lasts for this session, up to 15 minutes. App content may be sent to your selected model provider.\n\nRequested task: \(purpose)\n\nApp: \(app.bundleID)"
        alert.icon = app.app.icon
        alert.addButton(withTitle: "Allow this session")
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
        if let host = consentWindow, let sheet = host.attachedSheet { host.endSheet(sheet, returnCode: .cancel) }
    }

    func show(app: AppIdentity, target: WindowTarget, mode: AccessMode, purpose: String) {
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
        let buttons = NSStackView(views: [toggle, stop])
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
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown,
            .keyDown, .scrollWheel, .mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self] event in
            guard let self else { return }
            // Our own postToPid events cannot be mistaken for a person taking over.
            if event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == Int64(ProcessInfo.processInfo.processIdentifier) { return }
            if mode == .control || NSWorkspace.shared.frontmostApplication?.processIdentifier == app.pid {
                self.onPause?("You have control. Click Continue when you are ready.")
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
                   activated.processIdentifier != app.pid {
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
    }
    func update(_ message: String, paused: Bool) {
        isPaused = paused; status?.stringValue = message; toggle?.title = paused ? "Continue" : "Take over"
    }
    func updateExpiry(seconds: Int) {
        expiry?.stringValue = String(format: "Access ends in %d:%02d", seconds / 60, seconds % 60)
    }
    func close() {
        cancelConsent()
        panel?.close(); panel = nil; timer?.invalidate(); timer = nil
        if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll()
        if let stopObserver { DistributedNotificationCenter.default().removeObserver(stopObserver) }; stopObserver = nil
    }
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
        let description = NSTextField(wrappingLabelWithString: "macOS permissions enable the helper. You approve an app, a window and a control mode separately for each session. Stop or pause from the floating panel at any time.")
        let accessibility = NSTextField(labelWithString: "")
        let capture = NSTextField(labelWithString: "")
        let axButton = NSButton(title: "Open Accessibility settings", target: self, action: #selector(openAccessibility))
        let captureButton = NSButton(title: "Open Screen Recording settings", target: self, action: #selector(openCapture))
        let stop = NSButton(title: "Stop all Computer Use sessions", target: self, action: #selector(stopAll))
        let footer = NSTextField(wrappingLabelWithString: "If macOS asks you to restart after changing permissions, reconnect Computer Use in OpenWork. Windows and Linux desktop control are not available in this version.")
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
