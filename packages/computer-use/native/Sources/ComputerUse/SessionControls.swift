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
    var usesStaticMarker = false
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let image, let point = actionPoint, image.size.width > 0, image.size.height > 0 else { return }
        let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
        let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        let position = NSPoint(x: (bounds.width - size.width) / 2 + point.x * size.width,
                               y: (bounds.height - size.height) / 2 + (1 - point.y) * size.height)
        if usesStaticMarker {
            // A dispatch location on a still image, not the person's live pointer.
            let ring = NSBezierPath(ovalIn: NSRect(x: position.x - 8, y: position.y - 8, width: 16, height: 16))
            NSColor.black.withAlphaComponent(0.8).setStroke(); ring.lineWidth = 5; ring.stroke()
            NSColor.white.setStroke(); ring.lineWidth = 2; ring.stroke()
            NSColor.systemBlue.setFill()
            NSBezierPath(ovalIn: NSRect(x: position.x - 3, y: position.y - 3, width: 6, height: 6)).fill()
            return
        }
        NSColor.systemBlue.withAlphaComponent(0.5).setFill()
        NSBezierPath(ovalIn: NSRect(x: position.x - 9, y: position.y - 9, width: 18, height: 18)).fill()
        NSCursor.arrow.image.draw(in: NSRect(x: position.x, y: position.y - 18, width: 14, height: 20))
    }
}

@MainActor
private final class CoworkerControlPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class SessionControls: NSObject {
    static var hosted = false
    // Presentation only: Coworker keeps native consent and explicit Continue.
    static var coworkerPresentation = false
    static var embeddedCoworker = false
    static var automaticRecovery: Bool { hosted && !coworkerPresentation && !embeddedCoworker }
    static weak var active: SessionControls?
    private var hostID = UUID().uuidString
    private var hostState: [String: Any] = [:]
    private var frameSequence = 0
    private var inputSequence = 0
    private var lastFrameAt: TimeInterval = -.infinity
    private var canContinue = false
    private var approval: ((WindowTarget?) -> Void)?
    private var approvalWindows: [WindowTarget] = []
    private var previewView: AgentPreview?
    private var latestPreviewAt: TimeInterval?
    private var previewNeedsRefresh = true
    private var previewUnavailable = false
    private var emptyPreview: NSTextField?
    private var previewAge: NSTextField?
    private var previewState: NSTextField?
    private var actionLabel: NSTextField?
    private var stateLabel: NSTextField?
    private var coworkerStack: NSStackView?
    private var detailsStack: NSStackView?
    private var disclosureButton: NSButton?
    private var menuToggle: NSMenuItem?

    private func publish(_ values: [String: Any]) {
        guard Self.hosted && !Self.coworkerPresentation else { return }
        hostState.merge(values) { _, new in new }
        hostState["id"] = hostID
        if Self.embeddedCoworker {
            hostState["kind"] = "state"
            let fields: Set<String> = ["kind", "id", "phase", "appName", "appID", "pid", "windowTitle", "task", "mode", "windows", "status", "canContinue"]
            hostState = hostState.filter { fields.contains($0.key) }
            if hostState["phase"] as? String != "approval" { hostState.removeValue(forKey: "windows") }
        }
        MCPOutput.shared.send(["jsonrpc": "2.0", "method": "openwork/ui", "params": hostState])
    }
    func frame(_ data: Data, width: Int, height: Int, capturedAt: Int64) {
        guard Self.embeddedCoworker, Self.active === self, hostState["phase"] as? String == "working",
              MCPOutput.shared.canSendFrame, ProcessInfo.processInfo.systemUptime - lastFrameAt >= 0.2 else { return }
        lastFrameAt = ProcessInfo.processInfo.systemUptime
        frameSequence += 1
        MCPOutput.shared.send(["jsonrpc": "2.0", "method": "openwork/ui", "params": [
            "kind": "frame", "id": hostID, "sequence": frameSequence, "capturedAt": capturedAt,
            "width": width, "height": height, "mimeType": "image/png", "data": data.base64EncodedString()
        ]], frame: true)
    }
    func inputFeedback(_ feedback: InputFeedback) {
        guard Self.embeddedCoworker, Self.active === self,
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
        guard Self.hosted && !Self.coworkerPresentation,
              value["id"] as? String == hostID, let action = value["action"] as? String else { return }
        switch action {
        case "approve":
            guard let id = try? Arguments(values: value).integer("windowId", min: 1, max: Int(UInt32.max)),
                  let target = approvalWindows.first(where: { Int($0.id) == id }), let approval else { return }
            self.approval = nil; approvalWindows = []; approval(target)
        case "deny": cancelConsent()
        case "resume":
            if !Self.embeddedCoworker || (isPaused && canContinue) { onResume?() }
        case "takeover":
            if Self.embeddedCoworker { onPause?("You have control. Click Continue when you are ready.") }
        case "watch":
            guard Self.embeddedCoworker,
                  let visible = try? Arguments(values: value).bool("visible", default: false) else { return }
            onWatch?(visible)
        case "stop": cancelConsent(); onStop?()
        case "hide": hidePanel()
        case "show": showPanel()
        default: break
        }
    }
    func preview(_ data: Data) {
        guard Self.hosted || Self.coworkerPresentation, let previewView else { return }
        // This is the runtime's redacted observation. Never capture from the panel.
        guard let image = NSImage(data: data), image.size.width > 0, image.size.height > 0 else {
            previewUnavailable = true; previewNeedsRefresh = true
            refreshPreviewState()
            return
        }
        previewView.image = image
        latestPreviewAt = ProcessInfo.processInfo.systemUptime
        previewNeedsRefresh = false; previewUnavailable = false
        emptyPreview?.isHidden = true
        previewView.actionPoint = nil
        previewView.setAccessibilityLabel("Latest redacted screenshot of the approved window")
        refreshPreviewState()
    }
    private func refreshPreviewState() {
        guard Self.coworkerPresentation, let previewAge, let previewState else { return }
        guard let latestPreviewAt else {
            previewAge.stringValue = "Latest screenshot · none yet"
            previewState.stringValue = isPaused ? "Paused · no screenshot received" : "Screenshots arrive only when Coworker observes"
            if previewUnavailable { emptyPreview?.stringValue = "Screenshot unavailable\nWaiting for the next approved observation." }
            return
        }
        let age = max(0, Int(ProcessInfo.processInfo.systemUptime - latestPreviewAt))
        previewAge.stringValue = "Latest screenshot · \(age)s ago"
        if isPaused {
            previewState.stringValue = "Paused · last screenshot retained"
        } else if previewUnavailable {
            previewState.stringValue = "Screenshot unavailable · last image retained"
        } else if previewNeedsRefresh || age > 15 {
            previewState.stringValue = "Stale · waiting for a new screenshot"
        } else {
            previewState.stringValue = "Still image · not live video"
        }
        previewState.textColor = isPaused || previewNeedsRefresh || age > 15 ? .systemOrange : .secondaryLabelColor
        previewView?.setAccessibilityHelp("\(previewAge.stringValue). \(previewState.stringValue). A marker shows a dispatched action, not a verified result.")
    }
    func showAction(_ action: Action, observation: ObservationLease, records: [ElementRecord]) {
        guard Self.hosted || Self.coworkerPresentation else { return }
        let point: CGPoint?
        let label: String
        switch action {
        case .move(let location): point = location; label = "Pointer move"
        case .click(let location, let count): point = location; label = count == 1 ? "Click" : "Double-click"
        case .scroll(let location, _, _): point = location; label = "Scroll"
        case .drag(let path): point = path.last; label = "Drag"
        case .press(let ref), .setValue(let ref, _):
            label = action.name == "press" ? "Press control" : "Fill field"
            point = records.first(where: { $0.ref == ref }).map {
                CGPoint(x: ($0.frame.midX - observation.frame.minX) / observation.frame.width * CGFloat(observation.imageWidth),
                        y: ($0.frame.midY - observation.frame.minY) / observation.frame.height * CGFloat(observation.imageHeight))
            }
        case .key: point = nil; label = "Key press"
        case .type: point = nil; label = "Type text"
        }
        previewView?.actionPoint = nil
        // Text-only observations cannot place a truthful marker on an older image.
        if let point, !previewUnavailable, observation.imageDigest != nil, observation.imageWidth > 0, observation.imageHeight > 0,
           point.x.isFinite, point.y.isFinite, point.x >= 0, point.y >= 0,
           point.x < CGFloat(observation.imageWidth), point.y < CGFloat(observation.imageHeight) {
            previewView?.actionPoint = CGPoint(x: point.x / CGFloat(observation.imageWidth), y: point.y / CGFloat(observation.imageHeight))
        }
        actionLabel?.stringValue = "\(label) dispatched · outcome unverified"
        actionLabel?.toolTip = "The input was dispatched, not confirmed successful. A new observation is needed to inspect the result."
        previewNeedsRefresh = true
        refreshPreviewState()
        if !Self.coworkerPresentation { panel?.title = "Latest agent view · \(action.name) dispatched" }
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

    private func showCoworker(app: AppIdentity, target: WindowTarget, mode: AccessMode, purpose: String) {
        let panel = CoworkerControlPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 480),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Coworker Computer Use"
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.level = .floating; panel.isFloatingPanel = true; panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false; panel.isMovableByWindowBackground = true
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
        let content = NSView(frame: panel.contentLayoutRect)
        content.wantsLayer = true
        // Match Coworker's opaque panel/line palette, including reduced transparency.
        content.layer?.backgroundColor = NSColor(srgbRed: 18.0/255, green: 24.0/255, blue: 34.0/255, alpha: 1).cgColor
        content.layer?.borderColor = NSColor(srgbRed: 42.0/255, green: 52.0/255, blue: 68.0/255, alpha: 1).cgColor
        content.layer?.borderWidth = 1; content.layer?.cornerRadius = 16; content.layer?.masksToBounds = true
        panel.contentView = content

        func text(_ value: String, size: CGFloat = 11, weight: NSFont.Weight = .regular,
                  color: NSColor = .secondaryLabelColor, lines: Int = 1) -> NSTextField {
            let label = NSTextField(wrappingLabelWithString: value)
            label.font = .systemFont(ofSize: size, weight: weight); label.textColor = color
            label.maximumNumberOfLines = lines; label.lineBreakMode = .byTruncatingTail
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            if lines > 1 {
                label.preferredMaxLayoutWidth = 328
                label.heightAnchor.constraint(equalToConstant: CGFloat(lines * 16)).isActive = true
            }
            return label
        }
        func iconButton(_ symbol: String, name: String, action: Selector) -> NSButton {
            let button = NSButton(title: "", target: self, action: action)
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            button.imagePosition = .imageOnly; button.isBordered = false
            button.contentTintColor = .secondaryLabelColor
            button.toolTip = name; button.setAccessibilityLabel(name)
            button.widthAnchor.constraint(equalToConstant: 28).isActive = true
            button.heightAnchor.constraint(equalToConstant: 28).isActive = true
            return button
        }
        let icon = NSImageView()
        icon.image = app.app.icon; icon.imageScaling = .scaleProportionallyUpOrDown
        icon.setAccessibilityElement(false)
        icon.widthAnchor.constraint(equalToConstant: 32).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 32).isActive = true
        let name = text(String(app.name.prefix(100)), size: 13, weight: .semibold, color: .labelColor)
        name.toolTip = app.name
        let window = text(String(target.title.prefix(200)))
        window.toolTip = target.title; window.setAccessibilityLabel("Approved window")
        let identity = NSStackView(views: [name, window])
        identity.orientation = .vertical; identity.alignment = .leading; identity.spacing = 3
        identity.setContentHuggingPriority(.defaultLow, for: .horizontal)
        name.widthAnchor.constraint(equalTo: identity.widthAnchor).isActive = true
        window.widthAnchor.constraint(equalTo: identity.widthAnchor).isActive = true
        let collapse = iconButton("chevron.up", name: "Collapse screenshot and task", action: #selector(toggleDetails))
        let hide = iconButton("minus", name: "Hide panel; restore from the menu bar", action: #selector(hidePanel))
        let header = NSStackView(views: [icon, identity, collapse, hide])
        header.spacing = 8; header.alignment = .centerY
        let modeLabel = text("Coworker · \(mode.title)", weight: .medium)
        modeLabel.toolTip = mode.explanation
        let state = text("Approved window only", size: 12, weight: .semibold, color: .labelColor)
        let status = text("Starting. You can take over or stop at any time.", size: 12, lines: 3)
        status.setAccessibilityLabel("Computer use status")

        let task = text(String(purpose.prefix(500)), size: 12, color: .labelColor, lines: 2)
        task.setAccessibilityLabel("Approved task"); task.toolTip = String(purpose.prefix(500))
        let image = AgentPreview()
        image.imageScaling = .scaleProportionallyUpOrDown; image.imageAlignment = .alignCenter
        image.usesStaticMarker = true
        image.setAccessibilityLabel("Approved window screenshot; none received yet")
        image.wantsLayer = true; image.layer?.cornerRadius = 10; image.layer?.masksToBounds = true
        image.layer?.backgroundColor = NSColor(srgbRed: 9.0/255, green: 12.0/255, blue: 18.0/255, alpha: 1).cgColor
        image.heightAnchor.constraint(equalToConstant: 164).isActive = true
        let empty = text("Waiting for the first screenshot\nOnly approved window observations appear here.", size: 12, lines: 3)
        empty.alignment = .center; empty.translatesAutoresizingMaskIntoConstraints = false
        image.addSubview(empty)
        NSLayoutConstraint.activate([
            empty.leadingAnchor.constraint(equalTo: image.leadingAnchor, constant: 20),
            empty.trailingAnchor.constraint(equalTo: image.trailingAnchor, constant: -20),
            empty.centerYAnchor.constraint(equalTo: image.centerYAnchor),
        ])
        let age = text("Latest screenshot · none yet")
        age.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        age.toolTip = "Time since the last redacted screenshot arrived. The preview does not capture or refresh the screen itself."
        let imageState = text("Screenshots arrive only when Coworker observes")
        let action = text("No actions dispatched", weight: .medium, color: .labelColor)
        action.setAccessibilityLabel("Last dispatched action")
        let details = NSStackView(views: [task, image, age, imageState])
        details.orientation = .vertical; details.alignment = .leading; details.spacing = 6
        for view in details.views { view.widthAnchor.constraint(equalTo: details.widthAnchor).isActive = true }
        let expiry = text("Access ends in 15:00")
        expiry.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let toggle = NSButton(title: "Take over", target: self, action: #selector(togglePause))
        toggle.bezelStyle = .rounded; toggle.controlSize = .large
        toggle.bezelColor = NSColor(srgbRed: 120.0/255, green: 148.0/255, blue: 135.0/255, alpha: 1)
        toggle.keyEquivalent = ""; toggle.setAccessibilityLabel("Take over computer use")
        toggle.toolTip = "Pause Coworker. Only you can choose Continue to resume."
        let stop = NSButton(title: "Stop", target: self, action: #selector(stopSession))
        stop.bezelStyle = .rounded; stop.controlSize = .large; stop.bezelColor = .systemRed
        stop.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: nil)
        stop.imagePosition = .imageLeading
        stop.keyEquivalent = "\u{1b}"; stop.keyEquivalentModifierMask = []
        stop.setAccessibilityLabel("Stop computer use and end access")
        stop.toolTip = "Stop this session and end access (Esc while this panel has focus)."
        let buttons = NSStackView(views: [toggle, stop])
        buttons.spacing = 8
        stop.widthAnchor.constraint(equalToConstant: 92).isActive = true
        toggle.heightAnchor.constraint(equalToConstant: 32).isActive = true
        stop.heightAnchor.constraint(equalToConstant: 32).isActive = true
        toggle.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let stack = NSStackView(views: [header, modeLabel, state, status, details, action, expiry, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.setCustomSpacing(4, after: state)
        stack.detachesHiddenViews = true; stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        // A fixed content width survives detaching and restoring the details group.
        for view in stack.views { view.widthAnchor.constraint(equalToConstant: 328).isActive = true }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            stack.widthAnchor.constraint(equalToConstant: 328),
        ])
        panel.initialFirstResponder = toggle
        toggle.nextKeyView = stop; stop.nextKeyView = collapse; collapse.nextKeyView = hide; hide.nextKeyView = toggle
        self.panel = panel; self.status = status; self.toggle = toggle; self.expiry = expiry
        previewView = image; emptyPreview = empty; previewAge = age; previewState = imageState
        actionLabel = action; stateLabel = state; coworkerStack = stack; detailsStack = details; disclosureButton = collapse
        latestPreviewAt = nil; previewNeedsRefresh = true; previewUnavailable = false
        resizeCoworkerPanel()
        if let screen = NSScreen.main {
            panel.setFrameTopLeftPoint(NSPoint(x: screen.visibleFrame.maxX - 376, y: screen.visibleFrame.maxY - 16))
        }
        panel.orderFrontRegardless()

        showCoworkerMenu()
    }

    private func showCoworkerMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "Coworker computer use")
        item.button?.setAccessibilityTitle("Coworker computer use controls")
        item.button?.toolTip = Self.embeddedCoworker ? "Coworker Computer Use · Take over or Stop" : "Coworker Computer Use · Show controls or Stop"
        let menu = NSMenu(); menu.autoenablesItems = false
        if !Self.embeddedCoworker {
            let show = NSMenuItem(title: "Show Computer Use controls", action: #selector(showPanel), keyEquivalent: "")
            show.target = self; menu.addItem(show)
        }
        let pause = NSMenuItem(title: "Take over", action: #selector(togglePause), keyEquivalent: "")
        pause.target = self; menu.addItem(pause); menuToggle = pause
        menu.addItem(.separator())
        let end = NSMenuItem(title: "Stop computer use and end access", action: #selector(stopSession), keyEquivalent: "")
        end.target = self; menu.addItem(end)
        item.menu = menu; statusItem = item
    }

    private func resizeCoworkerPanel() {
        guard let panel, let coworkerStack else { return }
        var topLeft = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.setContentSize(NSSize(width: 360, height: ceil(coworkerStack.fittingSize.height) + 32))
        if let screen = panel.screen ?? NSScreen.main {
            let visible = screen.visibleFrame.insetBy(dx: 8, dy: 8)
            topLeft.x = min(max(topLeft.x, visible.minX), visible.maxX - panel.frame.width)
            topLeft.y = min(max(topLeft.y, visible.minY + panel.frame.height), visible.maxY)
        }
        panel.setFrameTopLeftPoint(topLeft)
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
    var onWatch: ((Bool) -> Void)?
    var isPaused = false

    func chooseWindow(app: AppIdentity, mode: AccessMode, windows: [WindowTarget], purpose: String) async throws -> WindowTarget {
        if Self.hosted && !Self.coworkerPresentation {
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
        alert.messageText = "Allow \(Self.coworkerPresentation ? "Coworker" : "OpenWork") to use \(app.name)?"
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
        host.title = Self.coworkerPresentation ? "Coworker · Approve window access" : "Computer Use · App access"
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
        if Self.embeddedCoworker {
            showCoworkerMenu()
            publish(["phase": "working", "appName": app.name, "appID": app.bundleID, "pid": Int(app.pid),
                "windowTitle": target.title, "task": purpose, "mode": mode.rawValue, "status": "Starting...", "canContinue": true])
        }
        else if Self.coworkerPresentation { showCoworker(app: app, target: target, mode: mode, purpose: purpose) }
        else if Self.hosted { showHosted(app: app, target: target, mode: mode, purpose: purpose) } else {
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
                    if Self.automaticRecovery { self?.onAppSwitch?() }
                    else { self?.onPause?("You switched apps. Continue will return to the approved window.") }
                }
            }
        })
        stopObserver = DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.differentai.openwork.computer-use.stop"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onStop?() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.onTick?(); self?.refreshPreviewState() }
        }
        // Keep expiry and screenshot age current while the menu-bar controls are open.
        if Self.coworkerPresentation || Self.embeddedCoworker, let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    func update(_ message: String, paused: Bool, canContinue: Bool = true, recoverable: Bool = false) {
        publish(["phase": paused ? "paused" : "working", "status": message, "canContinue": canContinue, "recoverable": recoverable])
        self.canContinue = canContinue
        if paused { previewNeedsRefresh = true }
        isPaused = paused; status?.stringValue = message; toggle?.title = paused ? "Continue" : "Take over"
        toggle?.isEnabled = !paused || canContinue
        if Self.coworkerPresentation || Self.embeddedCoworker {
            if message == "OpenWork is working. You can take over at any time." {
                status?.stringValue = "Coworker is working in the approved window. You can take over at any time."
            }
            status?.toolTip = message
            stateLabel?.stringValue = paused
                ? (canContinue ? "Paused · choose Continue to resume" : "Paused · waiting for your input to finish")
                : "Approved window only"
            stateLabel?.textColor = paused ? .systemOrange : .labelColor
            toggle?.setAccessibilityLabel(paused ? "Continue computer use in the approved window" : "Take over computer use")
            toggle?.toolTip = paused ? "Return to the approved window and resume. No input resumes automatically." : "Pause Coworker. Only you can choose Continue to resume."
            menuToggle?.title = paused ? "Continue in approved window" : "Take over"
            menuToggle?.isEnabled = !paused || canContinue
            refreshPreviewState()
        }
    }
    func updateExpiry(seconds: Int) {
        if !Self.embeddedCoworker { publish(["remainingSeconds": seconds]) }
        expiry?.stringValue = String(format: "Access ends in %d:%02d", seconds / 60, seconds % 60)
    }
    func close() {
        cancelConsent()
        if !Self.embeddedCoworker || (Self.active === self && hostState["phase"] as? String != "closed") {
            publish(["phase": "closed", "status": "Access ended.", "canContinue": false])
        }
        previewView = nil; Self.active = nil; canContinue = false
        latestPreviewAt = nil; previewNeedsRefresh = true; previewUnavailable = false
        emptyPreview = nil; previewAge = nil; previewState = nil; actionLabel = nil; stateLabel = nil
        coworkerStack = nil; detailsStack = nil; disclosureButton = nil; menuToggle = nil
        status = nil; toggle = nil; expiry = nil; isPaused = false
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }; statusItem = nil
        panel?.close(); panel = nil; timer?.invalidate(); timer = nil
        if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil
        for observer in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        workspaceObservers.removeAll()
        if let stopObserver { DistributedNotificationCenter.default().removeObserver(stopObserver) }; stopObserver = nil
    }
    @objc private func hidePanel() { panel?.orderOut(nil); publish(["previewVisible": false]) }
    @objc private func showPanel() {
        // An explicit restore can focus the controls without activating the app.
        if Self.coworkerPresentation { resizeCoworkerPanel(); panel?.makeKeyAndOrderFront(nil); refreshPreviewState() }
        else { panel?.orderFrontRegardless() }
        publish(["previewVisible": true])
    }
    @objc private func toggleDetails() {
        guard let detailsStack else { return }
        detailsStack.isHidden.toggle()
        let name = detailsStack.isHidden ? "Expand screenshot and task" : "Collapse screenshot and task"
        disclosureButton?.image = NSImage(systemSymbolName: detailsStack.isHidden ? "chevron.down" : "chevron.up", accessibilityDescription: nil)
        disclosureButton?.setAccessibilityLabel(name); disclosureButton?.toolTip = name
        resizeCoworkerPanel()
    }
    @objc private func togglePause() {
        if isPaused { if canContinue { onResume?() } }
        else { onPause?("You have control. Click Continue when you are ready.") }
    }
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
