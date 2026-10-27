import AppKit
import ApplicationServices
import Darwin
import Foundation

enum GuidePermission: String, Decodable, Hashable, Sendable {
    case accessibility, screenRecording

    var title: String { self == .accessibility ? "Allow app control" : "Allow window viewing" }
    var settingsName: String { self == .accessibility ? "Accessibility" : "Screen Recording" }
    var pane: String { self == .accessibility ? "Privacy_Accessibility" : "Privacy_ScreenCapture" }
}

private struct CoachPermissions: Decodable, Sendable {
    let accessibility: Bool
    let screenRecording: Bool
    var ready: Bool { accessibility && screenRecording }
    subscript(_ permission: GuidePermission) -> Bool {
        permission == .accessibility ? accessibility : screenRecording
    }
}

private enum CoachReadiness: String, Decodable, Sendable {
    case ready, setupRequired = "setup-required", unavailable, unsupported
}

private enum CoachMessage: Decodable, Sendable {
    case status(CoachReadiness?, CoachPermissions?)
    case request(GuidePermission)
    case close

    private enum CodingKeys: String, CodingKey { case type, readiness, permissions, permission }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .type) {
        case "status":
            self = .status(try? values.decode(CoachReadiness.self, forKey: .readiness),
                           try? values.decode(CoachPermissions.self, forKey: .permissions))
        case "request": self = .request(try values.decode(GuidePermission.self, forKey: .permission))
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

/// The OpenWork popover look: the app's light and dark tokens
/// (apps/app/src/app/index.css, styles/colors.css), solid rather than glass.
private enum CoachStyle {
    static let surface = color(light: 0xFCFCFD, dark: 0x18191B)
    static let hairline = color(light: 0x1C2024, dark: 0xEDEEF0, lightAlpha: 0.05, darkAlpha: 0.1)
    static let text = color(light: 0x1C2024, dark: 0xEDEEF0)
    static let secondaryText = color(light: 0x60646C, dark: 0x777B84)
    static let inverseText = color(light: 0xFCFCFD, dark: 0x111113)
    static let quietFill = color(light: 0xF0F0F3, dark: 0x212225)
    static let quietFillHover = color(light: 0xE8E8EC, dark: 0x272A2D)
    static let radius: CGFloat = 24
    static let controlRadius: CGFloat = 11
    static let inset: CGFloat = 20
    static let headerHeight: CGFloat = 28
    static let headerGap: CGFloat = 12

    private static func color(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let value = isDark ? dark : light
            return NSColor(srgbRed: CGFloat(value >> 16 & 0xFF) / 255, green: CGFloat(value >> 8 & 0xFF) / 255,
                           blue: CGFloat(value & 0xFF) / 255, alpha: isDark ? darkAlpha : lightAlpha)
        }
    }
}

/// Solid surface with a hairline, drawn so the window shadow follows its corners.
@MainActor
private final class PermissionCoachSurface: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: CoachStyle.radius - 0.5, yRadius: CoachStyle.radius - 0.5)
        CoachStyle.surface.setFill(); path.fill()
        CoachStyle.hairline.setStroke(); path.lineWidth = 1; path.stroke()
    }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}

@MainActor
private final class PermissionCoachButton: NSButton {
    /// primary: the filled main action; quiet: text actions; close: the round dismiss control.
    enum Role { case primary, quiet, close }
    var role = Role.quiet { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    private var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }

    override var needsPanelToBecomeKey: Bool { true }
    override var acceptsFirstResponder: Bool { isEnabled }
    override var intrinsicContentSize: NSSize {
        switch role {
        case .primary: return NSSize(width: NSView.noIntrinsicMetric, height: 36)
        case .close: return NSSize(width: 28, height: 28)
        case .quiet:
            let symbol = image.map { $0.size.width + 4 } ?? 0
            return NSSize(width: ceil(symbol + label(color: CoachStyle.secondaryText).size().width) + 4, height: 24)
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas where area.owner === self { removeTrackingArea(area) }
        // The guide never activates OpenWork, so hover must track while inactive.
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let active = hovering || isHighlighted
        switch role {
        case .primary:
            CoachStyle.text.withAlphaComponent(isHighlighted ? 0.7 : hovering ? 0.85 : 1).setFill()
            shape.fill()
            drawContent(color: CoachStyle.inverseText, centered: true)
        case .close:
            (active ? CoachStyle.quietFillHover : CoachStyle.quietFill).setFill()
            shape.fill()
            drawContent(color: active ? CoachStyle.text : CoachStyle.secondaryText, centered: true, showTitle: false)
        case .quiet:
            drawContent(color: active ? CoachStyle.text : CoachStyle.secondaryText, centered: false)
        }
    }

    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() { shape.fill() }

    private var shape: NSBezierPath {
        switch role {
        case .primary: NSBezierPath(roundedRect: bounds, xRadius: CoachStyle.controlRadius, yRadius: CoachStyle.controlRadius)
        case .close: NSBezierPath(ovalIn: bounds)
        case .quiet: NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6)
        }
    }

    private func label(color: NSColor) -> NSAttributedString {
        NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: role == .primary ? 13 : 12, weight: .medium), .foregroundColor: color])
    }

    private func drawContent(color: NSColor, centered: Bool, showTitle: Bool = true) {
        let text = showTitle ? label(color: color) : NSAttributedString()
        let symbol = image.map { tinted($0, color) }
        let gap: CGFloat = symbol != nil && showTitle ? 4 : 0
        let width = (symbol?.size.width ?? 0) + gap + text.size().width
        var x = centered ? (bounds.width - width) / 2 : 2
        if let symbol {
            let size = symbol.size
            symbol.draw(in: NSRect(x: x, y: (bounds.height - size.height) / 2, width: size.width, height: size.height),
                        from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            x += size.width + gap
        }
        if showTitle { text.draw(at: NSPoint(x: x, y: (bounds.height - text.size().height) / 2)) }
    }

    private func tinted(_ symbol: NSImage, _ color: NSColor) -> NSImage {
        NSImage(size: symbol.size, flipped: false) { rect in
            symbol.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
    }
}

@MainActor
private final class PermissionCoachDocument: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
final class PermissionCoach: NSObject, NSApplicationDelegate {
    private let initialPermission: GuidePermission
    private let hostPID = Responsibility.hostPID
    /// The System Settings entry macOS lists for this request, named by the host.
    private let entry: String? = {
        guard let value = ProcessInfo.processInfo.environment["OPENWORK_COMPUTER_USE_ENTRY"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty, value.count <= 64 else { return nil }
        return value
    }()
    private var currentPermission: GuidePermission
    private var permissions: CoachPermissions?
    private var requested: Set<GuidePermission> = []
    private var settingsFallback: Set<GuidePermission> = []
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

    init(permission: GuidePermission) {
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
        panel.title = "OpenWork permissions"
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.worksWhenModal = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.animationBehavior = .none
        // Follows the Mac's light or dark appearance, like OpenWork's default theme.
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.onClose = { [weak self] in self?.dismiss() }
        panel.autorecalculatesKeyViewLoop = true
        self.panel = panel

        let surface = PermissionCoachSurface()
        panel.contentView = surface

        let mark = NSImageView(image: NSApp.applicationIconImage)
        mark.imageScaling = .scaleProportionallyUpOrDown
        mark.setAccessibilityElement(false)
        mark.widthAnchor.constraint(equalToConstant: 18).isActive = true
        mark.heightAnchor.constraint(equalToConstant: 18).isActive = true
        let brand = NSTextField(labelWithString: "OpenWork")
        brand.font = .systemFont(ofSize: 13, weight: .semibold)
        brand.textColor = CoachStyle.text
        let close = PermissionCoachButton(title: "Close", target: self, action: #selector(dismiss))
        close.role = .close
        close.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close permission guide")?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        close.imagePosition = .imageOnly
        close.isBordered = false
        close.keyEquivalent = "\u{1b}"
        close.setAccessibilityLabel("Close permission guide")
        close.toolTip = "Close permission guide"
        let header = NSStackView(views: [mark, brand, NSView(), close])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8

        stepLabel.font = .systemFont(ofSize: 12, weight: .medium)
        stepLabel.textColor = CoachStyle.secondaryText
        taskLabel.font = .systemFont(ofSize: 13)
        taskLabel.textColor = CoachStyle.text
        identityLabel.font = .systemFont(ofSize: 12)
        identityLabel.textColor = CoachStyle.secondaryText
        helpLabel.font = .systemFont(ofSize: 12)
        helpLabel.textColor = CoachStyle.secondaryText
        for label in [taskLabel, identityLabel, helpLabel] { label.preferredMaxLayoutWidth = 344 - CoachStyle.inset * 2 }

        let primary = PermissionCoachButton(title: "Open settings", target: self, action: #selector(advance))
        primary.role = .primary
        primary.isBordered = false
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
        stack.spacing = 6
        stack.detachesHiddenViews = true
        stack.setCustomSpacing(4, after: stepLabel)
        stack.setCustomSpacing(16, after: identityLabel)
        stack.setCustomSpacing(8, after: primary)
        stack.setCustomSpacing(4, after: footer)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let document = PermissionCoachDocument(frame: NSRect(x: 0, y: 0, width: 344 - CoachStyle.inset * 2, height: 1))
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
        surface.addSubview(header)
        surface.addSubview(scroll)
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: CoachStyle.inset),
            header.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -CoachStyle.inset + 4),
            header.topAnchor.constraint(equalTo: surface.topAnchor, constant: CoachStyle.inset - 4),
            header.heightAnchor.constraint(equalToConstant: CoachStyle.headerHeight),
            scroll.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: CoachStyle.inset),
            scroll.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -CoachStyle.inset),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: CoachStyle.headerGap),
            scroll.bottomAnchor.constraint(equalTo: surface.bottomAnchor, constant: -CoachStyle.inset),
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
        titleLabel.attributedStringValue = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 17, weight: .semibold), .foregroundColor: CoachStyle.text, .kern: -0.2])
        if permissions == nil {
            taskLabel.stringValue = "Could not check. Try again."
        } else if ready {
            taskLabel.stringValue = "Return to OpenWork to continue."
        } else if settingsFallback.contains(currentPermission) {
            taskLabel.stringValue = "Open System Settings and search for “\(currentPermission.settingsName)”. Turn on \(entryPhrase)."
        } else {
            taskLabel.stringValue = "In \(currentPermission.settingsName), turn on \(entryPhrase)."
        }
        // A switch that is on but still waits belongs to an older, differently
        // signed copy. Toggling keeps that copy; only removing it replaces it.
        identityLabel.stringValue = entry.map { "Look for “\($0)” in the list. If it's already on and this still waits, macOS is holding an older copy: select it, remove it with −, then add \($0) again with +." }
            ?? "Turn on the app named in the macOS request."
        identityLabel.isHidden = ready
        stack?.setCustomSpacing(ready ? 16 : 6, after: taskLabel)
        primaryButton?.title = permissions == nil ? "Check again" : (ready ? "Back to OpenWork" : "Open settings")
        checkButton?.isHidden = permissions == nil
        helpButton?.image = NSImage(systemSymbolName: helpExpanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        helpButton?.setAccessibilityLabel(helpExpanded ? "Hide help" : "Show help")
        var help = "If the pane does not open, search System Settings for “\(currentPermission.settingsName)”."
        if currentPermission == .screenRecording {
            help += "\nmacOS may call it “Screen & System Audio Recording”."
        }
        help += "\nIf macOS offers Quit & Reopen, either choice is fine: OpenWork stays open and checks again on its own."
        helpLabel.stringValue = help
        helpLabel.isHidden = !helpExpanded
        positionPanel()
        panel.recalculateKeyViewLoop()
        // The shadow follows the drawn corners; recompute it after a resize.
        panel.displayIfNeeded()
        panel.invalidateShadow()
    }

    private var entryPhrase: String { entry.map { "“\($0)”" } ?? "the app named in the macOS request" }

    private func fitPanel(to screen: NSScreen) {
        guard let panel, let stack, let scrollView, let document = scrollView.documentView else { return }
        let visible = screen.visibleFrame.insetBy(dx: 12, dy: 12)
        let width = min(344, visible.width)
        let bodyWidth = max(1, width - CoachStyle.inset * 2)
        for label in [taskLabel, identityLabel, helpLabel] { label.preferredMaxLayoutWidth = bodyWidth }
        document.setFrameSize(NSSize(width: bodyWidth, height: document.frame.height))
        document.layoutSubtreeIfNeeded()
        let bodyHeight = ceil(stack.fittingSize.height)
        document.setFrameSize(NSSize(width: bodyWidth, height: bodyHeight))
        // Header row above the body, inset like the sides.
        let chrome = (CoachStyle.inset - 4) + CoachStyle.headerHeight + CoachStyle.headerGap + CoachStyle.inset
        let size = NSSize(width: width, height: min(bodyHeight + chrome, visible.height))
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

    private func request(_ permission: GuidePermission) {
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

    private func emit(_ event: String, permission: GuidePermission? = nil, visible: Bool? = nil) -> Bool {
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
