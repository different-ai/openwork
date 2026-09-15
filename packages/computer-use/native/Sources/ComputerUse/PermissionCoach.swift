import AppKit
import ApplicationServices
import Darwin
import Foundation

enum CoworkerPermission: String, Decodable, Hashable, Sendable {
    case accessibility, screenRecording

    var title: String { self == .accessibility ? "Allow app control" : "Allow window viewing" }
    var settingsName: String { self == .accessibility ? "Accessibility" : "Screen Recording" }
    var pane: String { self == .accessibility ? "Privacy_Accessibility" : "Privacy_ScreenCapture" }
}

private struct CoachPermissions: Decodable, Sendable {
    let accessibility: Bool
    let screenRecording: Bool
    var ready: Bool { accessibility && screenRecording }
    subscript(_ permission: CoworkerPermission) -> Bool {
        permission == .accessibility ? accessibility : screenRecording
    }
}

private enum CoachReadiness: String, Decodable, Sendable {
    case ready, setupRequired = "setup-required", unavailable, unsupported
}

private enum CoachMessage: Decodable, Sendable {
    case status(CoachReadiness?, CoachPermissions?)
    case request(CoworkerPermission)
    case close

    private enum CodingKeys: String, CodingKey { case type, readiness, permissions, permission }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .type) {
        case "status":
            self = .status(try? values.decode(CoachReadiness.self, forKey: .readiness),
                           try? values.decode(CoachPermissions.self, forKey: .permissions))
        case "request": self = .request(try values.decode(CoworkerPermission.self, forKey: .permission))
        case "close": self = .close
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: values, debugDescription: "Unknown coach message")
        }
    }
}

@MainActor
private final class PermissionCoachPanel: NSPanel {
    var onClose: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onClose?() }
    override func performClose(_ sender: Any?) { onClose?() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onClose?() }
        else if event.keyCode == 48 {
            if event.modifierFlags.contains(.shift) { selectPreviousKeyView(nil) }
            else { selectNextKeyView(nil) }
        } else { super.keyDown(with: event) }
    }
}

@MainActor
private final class PermissionCoachButton: NSButton {
    override var needsPanelToBecomeKey: Bool { true }
    override var acceptsFirstResponder: Bool { isEnabled }
}

@MainActor
private final class PermissionCoachDocument: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
final class PermissionCoach: NSObject, NSApplicationDelegate {
    private let initialPermission: CoworkerPermission
    private let hostPID = getppid()
    private var currentPermission: CoworkerPermission
    private var permissions: CoachPermissions?
    private var requested: Set<CoworkerPermission> = []
    private var settingsFallback: Set<CoworkerPermission> = []
    private var closed = false
    private var helpExpanded = false
    private var reportedVisibility: Bool?
    private var lastRefresh: TimeInterval = -.infinity
    private var panel: PermissionCoachPanel?
    private var stack: NSStackView?
    private var scrollView: NSScrollView?
    private let stepLabel = NSTextField(labelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "")
    private let taskLabel = NSTextField(wrappingLabelWithString: "")
    private let identityLabel = NSTextField(wrappingLabelWithString: "")
    private let helpLabel = NSTextField(wrappingLabelWithString: "")
    private var primaryButton: NSButton?
    private var helpButton: NSButton?
    private var checkButton: NSButton?
    private var timer: Timer?
    private var expiry: DispatchWorkItem?
    private var signalSources: [DispatchSourceSignal] = []
    private var inputTask: Task<Void, Never>?
    private var captureRequest: Task<Void, Never>?

    init(permission: CoworkerPermission) {
        initialPermission = permission
        currentPermission = permission
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let flags = fcntl(STDOUT_FILENO, F_GETFL)
        guard flags >= 0, fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else { dismiss(); return }
        signal(SIGPIPE, SIG_IGN)
        permissions = CoachPermissions(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
        makePanel()
        render()
        installSignals()
        readInput()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.updatePlacementAndVisibility() }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        let expiry = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.dismiss() } }
        self.expiry = expiry
        DispatchQueue.main.asyncAfter(deadline: .now() + 300, execute: expiry)
        positionPanel()
        panel?.orderFrontRegardless()
        panel?.displayIfNeeded()
        guard emit("ready") else { return }
        publishVisibility()
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.closed, self.permissions?[self.initialPermission] != true else { return }
                self.request(self.initialPermission)
            }
        }
    }

    private func makePanel() {
        let panel = PermissionCoachPanel(contentRect: NSRect(x: 0, y: 0, width: 344, height: 300),
                                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Open Coworker permissions"
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.worksWhenModal = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.animationBehavior = .none
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.onClose = { [weak self] in self?.dismiss() }
        panel.autorecalculatesKeyViewLoop = true
        self.panel = panel

        let material = NSVisualEffectView()
        material.material = .popover
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = 14
        material.layer?.masksToBounds = true
        material.layer?.borderWidth = 1
        material.layer?.borderColor = NSColor.separatorColor.cgColor
        panel.contentView = material

        let brand = NSTextField(labelWithString: "Open Coworker")
        brand.font = .systemFont(ofSize: 12, weight: .medium)
        brand.textColor = .secondaryLabelColor
        let close = PermissionCoachButton(title: "Close", target: self, action: #selector(dismiss))
        close.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close permission guide")
        close.imagePosition = .imageOnly
        close.isBordered = false
        close.keyEquivalent = "\u{1b}"
        close.setAccessibilityLabel("Close permission guide")
        close.toolTip = "Close permission guide"
        close.widthAnchor.constraint(equalToConstant: 24).isActive = true
        close.heightAnchor.constraint(equalToConstant: 24).isActive = true
        let header = NSStackView(views: [brand, NSView(), close])
        header.orientation = .horizontal
        header.alignment = .centerY

        stepLabel.font = .systemFont(ofSize: 11, weight: .medium)
        stepLabel.textColor = .secondaryLabelColor
        titleLabel.font = .systemFont(ofSize: 19, weight: .semibold)
        taskLabel.font = .systemFont(ofSize: 13)
        identityLabel.font = .systemFont(ofSize: 11)
        identityLabel.textColor = .secondaryLabelColor
        helpLabel.font = .systemFont(ofSize: 11)
        helpLabel.textColor = .secondaryLabelColor
        for label in [taskLabel, identityLabel, helpLabel] { label.preferredMaxLayoutWidth = 308 }

        let primary = PermissionCoachButton(title: "Open settings", target: self, action: #selector(advance))
        primary.bezelStyle = .rounded
        primary.controlSize = .large
        primary.heightAnchor.constraint(equalToConstant: 34).isActive = true
        let help = PermissionCoachButton(title: "Help", target: self, action: #selector(toggleHelp))
        help.isBordered = false
        help.imagePosition = .imageLeading
        let check = PermissionCoachButton(title: "Check again", target: self, action: #selector(refresh))
        check.isBordered = false
        let footer = NSStackView(views: [help, NSView(), check])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        primaryButton = primary
        helpButton = help
        checkButton = check

        let stack = NSStackView(views: [stepLabel, titleLabel, taskLabel, identityLabel, primary, footer, helpLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.detachesHiddenViews = true
        stack.setCustomSpacing(14, after: identityLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let document = PermissionCoachDocument(frame: NSRect(x: 0, y: 0, width: 308, height: 1))
        document.addSubview(stack)
        let scroll = NSScrollView()
        scroll.documentView = document
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        header.translatesAutoresizingMaskIntoConstraints = false
        material.addSubview(header)
        material.addSubview(scroll)
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: material.leadingAnchor, constant: 18),
            header.trailingAnchor.constraint(equalTo: material.trailingAnchor, constant: -18),
            header.topAnchor.constraint(equalTo: material.topAnchor, constant: 16),
            header.heightAnchor.constraint(equalToConstant: 24),
            scroll.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            scroll.bottomAnchor.constraint(equalTo: material.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            stack.topAnchor.constraint(equalTo: document.topAnchor)
        ])
        let fullWidth: [NSView] = [taskLabel, identityLabel, primary, footer, helpLabel]
        for view in fullWidth { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        self.stack = stack
        scrollView = scroll
        panel.initialFirstResponder = primary
    }

    private func render() {
        guard !closed, let panel else { return }
        if let permissions, permissions[currentPermission] && !permissions.ready {
            currentPermission = permissions.accessibility ? .screenRecording : .accessibility
        }
        let ready = permissions?.ready == true
        stepLabel.stringValue = ready ? "2 of 2 complete" : (permissions == nil ? "Permission check" :
            (permissions?.accessibility == true || permissions?.screenRecording == true ? "Step 2 of 2" : "Step 1 of 2"))
        let title = ready ? "Ready" : currentPermission.title
        if titleLabel.stringValue != title { scrollView?.contentView.scroll(to: .zero) }
        titleLabel.stringValue = title
        if permissions == nil {
            taskLabel.stringValue = "Could not check. Try again."
        } else if ready {
            taskLabel.stringValue = "Return to Coworker to continue."
        } else if settingsFallback.contains(currentPermission) {
            taskLabel.stringValue = "Open System Settings and search for “\(currentPermission.settingsName)”. Turn on the app named in the macOS request."
        } else {
            taskLabel.stringValue = "In \(currentPermission.settingsName), turn on the app named in the macOS request."
        }
        identityLabel.stringValue = "macOS may list Open Coworker or OpenWork Computer Use. Match the name in its request."
        identityLabel.isHidden = ready
        primaryButton?.title = permissions == nil ? "Check again" : (ready ? "Back to Coworker" : "Open settings")
        checkButton?.isHidden = permissions == nil
        helpButton?.image = NSImage(systemSymbolName: helpExpanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        helpButton?.setAccessibilityLabel(helpExpanded ? "Hide help" : "Show help")
        var help = "If the pane does not open, search System Settings for “\(currentPermission.settingsName)”."
        if currentPermission == .screenRecording {
            help += "\nmacOS may call it “Screen & System Audio Recording”."
        }
        help += "\nMatch the app name macOS requests. If macOS asks for Quit & Reopen, save your work, then restart Coworker."
        helpLabel.stringValue = help
        helpLabel.isHidden = !helpExpanded
        positionPanel()
        panel.recalculateKeyViewLoop()
    }

    private func fitPanel(to screen: NSScreen) {
        guard let panel, let stack, let scrollView, let document = scrollView.documentView else { return }
        let visible = screen.visibleFrame.insetBy(dx: 12, dy: 12)
        let width = min(344, visible.width)
        let bodyWidth = max(1, width - 36)
        for label in [taskLabel, identityLabel, helpLabel] { label.preferredMaxLayoutWidth = bodyWidth }
        document.setFrameSize(NSSize(width: bodyWidth, height: document.frame.height))
        document.layoutSubtreeIfNeeded()
        let bodyHeight = ceil(stack.fittingSize.height)
        document.setFrameSize(NSSize(width: bodyWidth, height: bodyHeight))
        let size = NSSize(width: width, height: min(bodyHeight + 64, visible.height))
        if panel.frame.size != size { panel.setContentSize(size) }
        panel.contentView?.layoutSubtreeIfNeeded()
        scrollView.contentView.scroll(to: scrollView.contentView.constrainBoundsRect(scrollView.contentView.bounds).origin)
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    @objc private func advance() {
        if permissions == nil { refresh() }
        else if permissions?.ready == true {
            if emit("return") { dismiss() }
        } else { request(currentPermission) }
    }

    @objc private func toggleHelp() {
        helpExpanded.toggle()
        render()
    }

    @objc private func refresh() { requestRefresh() }

    private func requestRefresh(force: Bool = false) {
        guard !closed else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard force || now - lastRefresh >= 1 else { return }
        lastRefresh = now
        _ = emit("refresh")
    }

    private func request(_ permission: CoworkerPermission) {
        guard !closed else { return }
        currentPermission = permission
        let shouldPrompt = permissions?[permission] != true && requested.insert(permission).inserted
        render()
        if panel?.isVisible == false { panel?.orderFrontRegardless() }
        publishVisibility()
        panel?.displayIfNeeded()
        if shouldPrompt {
            guard emit("requested", permission: permission) else { return }
            if permission == .accessibility {
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            } else {
                captureRequest = Task.detached(priority: .userInitiated) { [weak self] in
                    guard !Task.isCancelled else { return }
                    _ = CGRequestScreenCaptureAccess()
                    guard !Task.isCancelled else { return }
                    await self?.requestRefresh(force: true)
                }
            }
        }
        guard !closed else { return }
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(permission.pane)")!
        if NSWorkspace.shared.open(url) { settingsFallback.remove(permission) }
        else { settingsFallback.insert(permission) }
        render()
        refresh()
    }

    private func receive(_ message: CoachMessage) {
        guard !closed else { return }
        switch message {
        case .status(let readiness, let permissions):
            self.permissions = readiness == .ready || readiness == .setupRequired ? permissions : nil
            render()
        case .request(let permission): request(permission)
        case .close: dismiss()
        }
    }

    private func readInput() {
        inputTask = Task.detached(priority: .utility) { [weak self] in
            let decoder = JSONDecoder()
            var buffer = [UInt8](repeating: 0, count: 4096)
            var pending = Data()
            var oversized = false
            while !Task.isCancelled {
                let count = buffer.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
                if count == 0 { break }
                if count < 0 {
                    if errno == EINTR { continue }
                    break
                }
                for byte in buffer.prefix(count) {
                    if byte == 10 {
                        if !oversized, !pending.isEmpty, let message = try? decoder.decode(CoachMessage.self, from: pending) {
                            await self?.receive(message)
                        }
                        pending.removeAll(keepingCapacity: true)
                        oversized = false
                    } else if !oversized {
                        if pending.count >= 4096 { oversized = true; pending.removeAll(keepingCapacity: true) }
                        else { pending.append(byte) }
                    }
                }
            }
            await self?.dismiss()
        }
    }

    private func emit(_ event: String, permission: CoworkerPermission? = nil, visible: Bool? = nil) -> Bool {
        guard !closed else { return false }
        var payload: [String: Any] = ["event": event]
        if let permission { payload["permission"] = permission.rawValue }
        if let visible { payload["visible"] = visible }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { dismiss(); return false }
        let line = data + Data([10])
        var count = line.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress, $0.count) }
        if count < 0 && errno == EINTR {
            count = line.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress, $0.count) }
        }
        guard count == line.count else { dismiss(); return false }
        return true
    }

    private func installSignals() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.dismiss() } }
            signalSources.append(source)
            source.resume()
        }
    }

    private func updatePlacementAndVisibility() {
        guard !closed, let panel else { return }
        let foreground = NSWorkspace.shared.frontmostApplication
        let bundleID = foreground?.bundleIdentifier?.lowercased()
        let systemPrompt = !requested.isEmpty && ["com.apple.securityagent", "com.apple.usernotificationcenter", "com.apple.coreservicesuiagent", "com.apple.tccd"].contains(bundleID ?? "")
        let related = panel.isKeyWindow || foreground?.processIdentifier == getpid() || foreground?.processIdentifier == hostPID ||
            bundleID == "com.apple.systempreferences" || systemPrompt
        guard related else { panel.orderOut(nil); publishVisibility(); return }
        if !panel.isKeyWindow { positionPanel() }
        if !panel.isVisible { panel.orderFrontRegardless() }
        publishVisibility()
    }

    private func publishVisibility() {
        guard !closed, let panel, reportedVisibility != panel.isVisible else { return }
        reportedVisibility = panel.isVisible
        _ = emit("visibility", visible: panel.isVisible)
    }

    private func settingsBounds() -> NSRect? {
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").map(\.processIdentifier))
        guard !pids.isEmpty,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let primary = NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == CGMainDisplayID() }) else { return nil }
        return windows.compactMap { value -> NSRect? in
            guard let pid = value[kCGWindowOwnerPID as String] as? NSNumber, pids.contains(pid.int32Value),
                  (value[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let bounds = value[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  rect.width > 200, rect.height > 200 else { return nil }
            return NSRect(x: rect.minX, y: primary.frame.maxY - rect.maxY, width: rect.width, height: rect.height)
        }.max { $0.width * $0.height < $1.width * $1.height }
    }

    private func positionPanel() {
        guard !closed, let panel, !NSScreen.screens.isEmpty else { return }
        let settings = settingsBounds()
        let screens = NSScreen.screens
        let preferred = settings.flatMap { bounds in
            screens.max { intersectionArea($0.frame, bounds) < intersectionArea($1.frame, bounds) }
        } ?? panel.screen ?? NSScreen.main ?? screens[0]
        fitPanel(to: preferred)
        let ordered = [preferred] + screens.filter { $0 !== preferred }
        let size = panel.frame.size
        var best: NSRect?
        var overlap = CGFloat.infinity
        for screen in ordered {
            let visible = screen.visibleFrame.insetBy(dx: 12, dy: 12)
            guard size.width <= visible.width, size.height <= visible.height else { continue }
            var candidates: [NSRect] = []
            if let settings {
                let y = min(max(settings.maxY - size.height, visible.minY), visible.maxY - size.height)
                let x = min(max(settings.minX, visible.minX), visible.maxX - size.width)
                candidates += [NSRect(x: settings.maxX + 12, y: y, width: size.width, height: size.height),
                               NSRect(x: settings.minX - size.width - 12, y: y, width: size.width, height: size.height),
                               NSRect(x: x, y: settings.maxY + 12, width: size.width, height: size.height),
                               NSRect(x: x, y: settings.minY - size.height - 12, width: size.width, height: size.height)]
            }
            for x in [visible.maxX - size.width, visible.minX] {
                for y in [visible.maxY - size.height, visible.minY] {
                    candidates.append(NSRect(x: x, y: y, width: size.width, height: size.height))
                }
            }
            for candidate in candidates where visible.contains(candidate) {
                let area = settings.map { intersectionArea(candidate, $0) } ?? 0
                if area < overlap { best = candidate; overlap = area }
                if area == 0 { break }
            }
            if overlap == 0 { break }
        }
        if let best {
            if panel.frame != best { panel.setFrame(best, display: true, animate: false) }
        } else {
            let visible = preferred.visibleFrame.insetBy(dx: 12, dy: 12)
            panel.setFrameTopLeftPoint(NSPoint(x: visible.maxX - size.width, y: visible.maxY))
        }
    }

    private func intersectionArea(_ a: NSRect, _ b: NSRect) -> CGFloat {
        let intersection = a.intersection(b)
        return intersection.isNull ? 0 : intersection.width * intersection.height
    }

    @objc private func dismiss() {
        guard !closed else { return }
        cleanUp()
        NSApp.terminate(nil)
    }

    private func cleanUp() {
        guard !closed else { return }
        closed = true
        timer?.invalidate(); timer = nil
        expiry?.cancel(); expiry = nil
        for source in signalSources { source.cancel() }
        signalSources.removeAll()
        inputTask?.cancel(); inputTask = nil
        captureRequest?.cancel(); captureRequest = nil
        panel?.onClose = nil
        panel?.orderOut(nil); panel?.close(); panel = nil
    }

    func applicationWillTerminate(_ notification: Notification) { cleanUp() }
}
