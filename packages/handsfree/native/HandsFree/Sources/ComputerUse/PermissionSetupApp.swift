import AppKit
import ApplicationServices
import Foundation

enum ComputerUsePermissionTarget: String {
    case accessibility
    case screenRecording = "screen-recording"
}

struct ComputerUsePermissionStatus {
    let accessibility: Bool
    let screenRecording: Bool
    var ok: Bool { accessibility && screenRecording }
    var dictionary: [String: Any] {
        ["ok": ok, "accessibility": accessibility, "screenRecording": screenRecording]
    }
}

enum ComputerUsePermissions {
    /// Non-prompting check — safe to call on a timer / from HTTP polling.
    static func status() -> ComputerUsePermissionStatus {
        ComputerUsePermissionStatus(
            accessibility: AXIsProcessTrusted(),
            screenRecording: CGPreflightScreenCaptureAccess()
        )
    }

    /// Prompting request — only call when the user explicitly clicks "Grant".
    static func request(_ target: ComputerUsePermissionTarget) {
        switch target {
        case .accessibility:
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        case .screenRecording:
            _ = CGRequestScreenCaptureAccess()
        }
    }
}

// MARK: - App delegate

@MainActor
final class PermissionSetupAppDelegate: NSObject, NSApplicationDelegate {
    private var windowController: NSWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = PermissionSetupWindow()
        let vc = PermissionSetupViewController()
        window.contentViewController = vc
        let wc = NSWindowController(window: window)
        windowController = wc
        wc.showWindow(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

// MARK: - Window

private final class PermissionSetupWindow: NSWindow {
    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 600),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        title = "OpenWork Computer Use"
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        center()
    }
}

// MARK: - View controller

@MainActor
final class PermissionSetupViewController: NSViewController {
    private var axBadge = StatusBadge()
    private var srBadge = StatusBadge()
    private var axGrantButton: NSButton?
    private var srGrantButton: NSButton?
    private var timer: Timer?

    init() { super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { nil }
    deinit { timer?.invalidate() }

    override func loadView() {
        // Liquid glass: NSVisualEffectView blending with content behind the window
        let blur = NSVisualEffectView()
        blur.material = .underWindowBackground
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 12
        blur.layer?.masksToBounds = true
        view = blur
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        buildLayout()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            guard let controller = self else { return }
            Task { @MainActor in controller.refresh() }
        }
    }

    private func buildLayout() {
        let iconView = NSImageView()
        iconView.image = NSApplication.shared.applicationIconImage
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.widthAnchor.constraint(equalToConstant: 52).isActive = true
        iconView.heightAnchor.constraint(equalToConstant: 52).isActive = true

        let titleField = textField("Computer Use Setup", size: 20, weight: .semibold)
        titleField.alignment = .center

        let subtitleField = wrappingField(
            "Grant two permissions so agents can see and control apps in the background.",
            size: 13
        )
        subtitleField.textColor = .secondaryLabelColor
        subtitleField.alignment = .center

        let header = vstack([iconView, titleField, subtitleField], spacing: 8, alignment: NSLayoutConstraint.Attribute.centerX)

        let axCard = makeAccessibilityCard()
        let srCard = makeScreenRecordingCard()

        let doneBtn = NSButton(title: "Done — Return to OpenWork", target: self, action: #selector(done))
        doneBtn.bezelStyle = .rounded
        doneBtn.controlSize = .large
        doneBtn.keyEquivalent = "\r"

        let root = vstack([header, axCard, srCard, doneBtn], spacing: 14, alignment: NSLayoutConstraint.Attribute.leading)
        root.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(root)

        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            root.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            root.topAnchor.constraint(greaterThanOrEqualTo: view.topAnchor, constant: 52),
            root.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -20),
            root.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 10),
            axCard.widthAnchor.constraint(equalTo: root.widthAnchor),
            srCard.widthAnchor.constraint(equalTo: root.widthAnchor),
            doneBtn.widthAnchor.constraint(equalTo: root.widthAnchor),
        ])
    }

    // MARK: Accessibility card

    private func makeAccessibilityCard() -> NSView {
        let step = StepCircle(number: "1")
        let title = textField("Accessibility", size: 15, weight: .semibold)
        let body = wrappingField(
            "Allows agents to interact with UI controls, click buttons, and type text entirely in the background.",
            size: 13
        )
        body.textColor = .secondaryLabelColor

        let btn = NSButton(title: "Grant Accessibility", target: self, action: #selector(grantAccessibility))
        btn.bezelStyle = .rounded
        btn.controlSize = .regular
        axGrantButton = btn

        let top = hstack([step, title, springy(), axBadge], spacing: 8)
        let inner = vstack([top, body, btn], spacing: 10, alignment: NSLayoutConstraint.Attribute.leading)
        btn.widthAnchor.constraint(equalTo: inner.widthAnchor).isActive = true

        return glassCard(inner)
    }

    // MARK: Screen Recording card

    private func makeScreenRecordingCard() -> NSView {
        let step = StepCircle(number: "2")
        let title = textField("Screen Recording", size: 15, weight: .semibold)
        let body = wrappingField(
            "Lets agents see what is on screen. If macOS does not prompt automatically, drag the app icon below into the Screen Recording list.",
            size: 13
        )
        body.textColor = .secondaryLabelColor

        let dragFlow = makeDragFlowView()

        let reqBtn = NSButton(title: "Request Screen Recording", target: self, action: #selector(requestScreenRecording))
        reqBtn.bezelStyle = .rounded
        reqBtn.controlSize = .regular
        srGrantButton = reqBtn

        let openBtn = NSButton(title: "Open Privacy & Security", target: self, action: #selector(openPrivacySecurity))
        openBtn.bezelStyle = .rounded
        openBtn.controlSize = .small

        let top = hstack([step, title, springy(), srBadge], spacing: 8)
        let inner = vstack([top, body, dragFlow, reqBtn, openBtn], spacing: 10, alignment: NSLayoutConstraint.Attribute.leading)
        reqBtn.widthAnchor.constraint(equalTo: inner.widthAnchor).isActive = true
        openBtn.widthAnchor.constraint(equalTo: inner.widthAnchor).isActive = true
        dragFlow.widthAnchor.constraint(equalTo: inner.widthAnchor).isActive = true

        return glassCard(inner)
    }

    // MARK: Drag flow visualization

    private func makeDragFlowView() -> NSView {
        // Large draggable app icon
        let iconView = DraggableAppIconView(frame: .zero)
        iconView.image = NSApplication.shared.applicationIconImage
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.widthAnchor.constraint(equalToConstant: 56).isActive = true
        iconView.heightAnchor.constraint(equalToConstant: 56).isActive = true

        let dragHint = textField("Drag me", size: 10)
        dragHint.textColor = .tertiaryLabelColor
        dragHint.alignment = .center

        let iconCol = vstack([iconView, dragHint], spacing: 5, alignment: NSLayoutConstraint.Attribute.centerX)

        let arrow = textField("→", size: 20)
        arrow.textColor = .tertiaryLabelColor

        let dropZone = PrivacyDropZoneView()
        dropZone.translatesAutoresizingMaskIntoConstraints = false
        dropZone.widthAnchor.constraint(equalToConstant: 116).isActive = true
        dropZone.heightAnchor.constraint(equalToConstant: 60).isActive = true

        let row = hstack([iconCol, arrow, dropZone], spacing: 14)
        row.alignment = NSLayoutConstraint.Attribute.centerY
        row.distribution = NSStackView.Distribution.fill

        let hint = wrappingField(
            "Drag this icon into the Screen Recording list in Privacy & Security, then enable it.",
            size: 11
        )
        hint.textColor = .secondaryLabelColor
        hint.alignment = .center

        let content = vstack([row, hint], spacing: 8, alignment: NSLayoutConstraint.Attribute.centerX)
        content.translatesAutoresizingMaskIntoConstraints = false

        let wrapper = InnerTintView()
        wrapper.translatesAutoresizingMaskIntoConstraints = false
        wrapper.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: wrapper.topAnchor, constant: 12),
            content.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor, constant: -12),
            content.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: 12),
            content.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -12),
        ])
        return wrapper
    }

    // MARK: Refresh

    private func refresh() {
        let status = ComputerUsePermissions.status()
        axBadge.update(granted: status.accessibility)
        srBadge.update(granted: status.screenRecording)
        axGrantButton?.isEnabled = !status.accessibility
        srGrantButton?.isEnabled = !status.screenRecording
    }

    // MARK: Actions

    @objc private func grantAccessibility() {
        ComputerUsePermissions.request(.accessibility)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.refresh() }
    }

    @objc private func requestScreenRecording() {
        ComputerUsePermissions.request(.screenRecording)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.refresh() }
    }

    @objc private func openPrivacySecurity() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func done() {
        NSApplication.shared.terminate(nil)
    }

    // MARK: Builder helpers

    private func glassCard(_ content: NSView) -> GlassCardView {
        let card = GlassCardView()
        card.addContent(content)
        return card
    }

    private func textField(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular) -> NSTextField {
        let f = NSTextField(labelWithString: text)
        f.font = .systemFont(ofSize: size, weight: weight)
        return f
    }

    private func wrappingField(_ text: String, size: CGFloat) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: text)
        f.font = .systemFont(ofSize: size)
        return f
    }

    private func vstack(_ views: [NSView], spacing: CGFloat, alignment: NSLayoutConstraint.Attribute = NSLayoutConstraint.Attribute.leading) -> NSStackView {
        let sv = NSStackView(views: views)
        sv.orientation = .vertical
        sv.spacing = spacing
        sv.alignment = alignment
        return sv
    }

    private func hstack(_ views: [NSView], spacing: CGFloat) -> NSStackView {
        let sv = NSStackView(views: views)
        sv.orientation = .horizontal
        sv.spacing = spacing
        sv.alignment = NSLayoutConstraint.Attribute.centerY
        return sv
    }

    private func springy() -> NSView {
        let v = NSView()
        v.setContentHuggingPriority(.defaultLow, for: .horizontal)
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return v
    }
}

// MARK: - Glass card

/// NSView container with an NSVisualEffectView inside for the glass effect.
/// Uses updateLayer() so the border color responds to appearance changes.
final class GlassCardView: NSView {
    private let blur: NSVisualEffectView

    override init(frame: NSRect) {
        blur = NSVisualEffectView()
        blur.material = .contentBackground
        blur.blendingMode = .withinWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = 13
        blur.layer?.masksToBounds = true
        blur.translatesAutoresizingMaskIntoConstraints = false

        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 14

        addSubview(blur)
        NSLayoutConstraint.activate([
            blur.topAnchor.constraint(equalTo: topAnchor),
            blur.bottomAnchor.constraint(equalTo: bottomAnchor),
            blur.leadingAnchor.constraint(equalTo: leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.borderWidth = 0.5
        layer?.borderColor = NSColor.separatorColor.cgColor
    }

    func addContent(_ content: NSView) {
        content.translatesAutoresizingMaskIntoConstraints = false
        blur.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: blur.topAnchor, constant: 16),
            content.bottomAnchor.constraint(equalTo: blur.bottomAnchor, constant: -16),
            content.leadingAnchor.constraint(equalTo: blur.leadingAnchor, constant: 16),
            content.trailingAnchor.constraint(equalTo: blur.trailingAnchor, constant: -16),
        ])
    }
}

// MARK: - Status badge

/// Pill badge showing Granted/Needed with adaptive color.
@MainActor
final class StatusBadge: NSView {
    private let dot = NSView()
    private let label = NSTextField(labelWithString: "")
    private var isGranted = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 10

        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 8).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 8).isActive = true

        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.translatesAutoresizingMaskIntoConstraints = false

        let row = NSStackView(views: [dot, label])
        row.orientation = .horizontal
        row.spacing = 5
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)

        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func update(granted: Bool) {
        isGranted = granted
        applyColors()
        label.stringValue = granted ? "Granted" : "Needed"
        label.textColor = granted ? .systemGreen : .systemOrange
    }

    private func applyColors() {
        layer?.backgroundColor = isGranted
            ? NSColor.systemGreen.withAlphaComponent(0.15).cgColor
            : NSColor.systemOrange.withAlphaComponent(0.12).cgColor
        dot.layer?.backgroundColor = isGranted
            ? NSColor.systemGreen.cgColor
            : NSColor.systemOrange.cgColor
    }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() { applyColors() }
}

// MARK: - Step circle

private final class StepCircle: NSView {
    init(number: String) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.controlAccentColor.cgColor
        layer?.cornerRadius = 11
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 22).isActive = true
        heightAnchor.constraint(equalToConstant: 22).isActive = true

        let label = NSTextField(labelWithString: number)
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textColor = .white
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.backgroundColor = NSColor.controlAccentColor.cgColor
    }
}

// MARK: - Inner tint (drag flow background)

/// Subtle tinted background for the drag-flow visualization.
/// Adapts to light/dark appearance via updateLayer().
private final class InnerTintView: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 10
    }

    required init?(coder: NSCoder) { nil }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        layer?.backgroundColor = isDark
            ? NSColor.white.withAlphaComponent(0.05).cgColor
            : NSColor.black.withAlphaComponent(0.04).cgColor
    }
}

// MARK: - Privacy drop zone

/// Dashed rounded rect showing where the user should drop the app icon.
final class PrivacyDropZoneView: NSView {
    private let label: NSTextField

    override init(frame: NSRect) {
        label = NSTextField(labelWithString: "Screen Recording\nlist")
        super.init(frame: frame)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .tertiaryLabelColor
        label.alignment = .center
        label.maximumNumberOfLines = 2
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 4),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -4),
        ])
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSGraphicsContext.saveGraphicsState()
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 8, yRadius: 8)
        path.lineWidth = 1.5
        path.setLineDash([6.0, 4.0], count: 2, phase: 0)
        NSColor.tertiaryLabelColor.setStroke()
        path.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }
}

// MARK: - Draggable app icon

/// NSImageView that initiates a drag session carrying the app bundle URL,
/// so it can be dropped into System Settings > Privacy & Security > Screen Recording.
final class DraggableAppIconView: NSImageView, NSDraggingSource {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.masksToBounds = true
        addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        ))
    }

    required init?(coder: NSCoder) { nil }

    override func mouseEntered(with event: NSEvent) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            animator().alphaValue = 0.75
        }
    }

    override func mouseExited(with event: NSEvent) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            animator().alphaValue = 1.0
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let image else { return }
        let appURL = Bundle.main.bundleURL
        let item = NSPasteboardItem()
        item.setString(appURL.absoluteString, forType: .fileURL)
        let dragItem = NSDraggingItem(pasteboardWriter: item)
        dragItem.setDraggingFrame(bounds, contents: image)
        beginDraggingSession(with: [dragItem], event: event, source: self)
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        .copy
    }
}


